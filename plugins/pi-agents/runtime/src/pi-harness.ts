import { Harness, createRegistry, defineDoc, defineTool, defineExtension, configure, LiveDoc,
  type ToolRegistration, type ToolExecutionApi, type Conversation } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createReadTool, createWriteTool, createEditTool, createBashTool } from "@earendil-works/pi-durable/tools";
import { BACKGROUND_CONTEXT as context, awaitWithContext, type Context } from "@earendil-works/chord/context";
import type { JsonObject, ConversationId, TaskId, SubmissionId } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { mkdirSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { WorkerReportSchema } from "./contracts.js";
import { CheckpointInputSchema } from "./progress.js";
import { assertFrozenEffectiveConfig, effectiveConfigHash, policyNeutralConfigHash, PI_VERSION, type FrozenPolicy, type ManagedLaunchContract } from "./launch-config.js";
import { createWorkerModels } from "./pi-models.js";
import { readTools } from "./pi-read-tools.js";
import { networkTools } from "./pi-network-tools.js";
import { checkedPath, createBoundedEnv } from "./pi-env.js";
import type { PendingRequest, TurnObservation, BackendEvent } from "./backend.js";

import { validateWorkerExplanation } from "./request-feedback.js";

type Request = { id: string; sessionId: string; messageId: string; taskId: number; tool: string;
  args: string; status: "pending" | "allow_once" | "deny" | "consumed"; uncertain: boolean; workerExplanation?: string };
type Turn = { sessionId: string; submissionId: number; promptHash: string };
type State = { markers: Record<string, string>; policies: Record<string, string>;
  messages: Record<string, string>; turns: Record<string, Turn>; requests: Record<string, Request>; cancelled: Record<string, boolean> };
export const WorkerState = defineDoc<State>({ kind: "pi-agents.worker", version: 1, scope: "session",
  initial: () => ({ markers: {}, policies: {}, messages: {}, turns: {}, requests: {}, cancelled: {} }),
  checkpointWhen: () => true });
const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });

/** Pi owns execution; this wrapper only binds it to the supervisor's durable identities. */
export class PiHarness {
  private constructor(readonly harness: Harness, readonly contract: ManagedLaunchContract,
    readonly backendId: string, readonly workspace: string) {}
  private events: Array<{ seq: number; event: BackendEvent }> = [];
  private sequence = 0;

  static async open(directory: string, contract: ManagedLaunchContract, backendId: string,
    models?: import("@earendil-works/pi-ai").Models): Promise<PiHarness> {
    const policy = JSON.parse(contract.configContent) as FrozenPolicy;
    assertFrozenEffectiveConfig(policy, contract);
    if (policy.version !== PI_VERSION || policy.reportPath !== contract.reportPath) throw new Error("unsupported Pi launch contract");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const registry = createRegistry();
    let worker!: PiHarness;
    registry.install(defineExtension({ name: "pi-agents-worker", tools: PiHarness.tools(() => worker) }));
    const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "pi.sqlite")), {
      models: models ?? createWorkerModels(policy), registry,
      settings: { toolExecution: "sequential", retry: { maxRetries: 3 }, restartLimit: 5, afterFailedRun: "withdraw" },
      env: async ({ conversationId, read }, ctx) => {
        const state = await read.snapshot(WorkerState, ctx);
        const frozen = state?.policies[conversationId];
        if (!frozen) throw new Error("conversation has no frozen execution policy");
        return createBoundedEnv(JSON.parse(frozen) as FrozenPolicy);
      },
    }, context);
    worker = new PiHarness(harness, contract, backendId, policy.workspace);
    return worker;
  }

  private static tools(worker: () => PiHarness): ToolRegistration[] {
    const read = { ...createReadTool(), replay: "safe" as const };
    const effects: ToolRegistration[] = [createWriteTool(), createEditTool(), createBashTool(), ...networkTools()];
    const tools: ToolRegistration[] = [read, ...readTools(async (api, ctx) => {
      const state = await api.snapshot(WorkerState, ctx);
      return JSON.parse(state!.policies[api.conversationId]!) as FrozenPolicy;
    })];
    for (const effect of effects) {
      // The outer gate safely reattaches to a durable permission. The nested effect never replays.
      const internal = `pi_effect_${effect.name}`;
      tools.push({ ...effect, name: internal, callers: ["tools"], replay: "unsafe" });
      tools.push({ ...effect, replay: "safe", execute: async (args, api, ctx) => {
        const w = worker();
        const state = await api.snapshot(WorkerState, ctx);
        const policy = JSON.parse(state!.policies[api.conversationId]!) as FrozenPolicy;
        const input = args as JsonObject;
        const fileEffect = effect.name === "write" || effect.name === "edit";
        if (!fileEffect) {
          if (policy.profile !== "bounded-build") throw new Error(`${effect.name} is disabled for bounded-inspect`);
        } else checkedPath(policy, String(input.path), true);
        const reportWrite = fileEffect && String(input.path) &&
          checkedPath(policy, String(input.path), true).startsWith(policy.reportPath + "/");
        if (!reportWrite) await w.permission(effect.name, input, api, ctx);
        const result = await api.executeTool(internal, input, ctx, { key: "effect" });
        // A completed process with a nonzero exit is a known check result, not an interrupted effect.
        const exitCode = effect.name === "bash" && result.structuredOutput && typeof result.structuredOutput === "object"
          ? (result.structuredOutput as { exitCode?: unknown }).exitCode : undefined;
        const knownProcessExit = typeof exitCode === "number" && Number.isInteger(exitCode);
        const uncertain = result.isError === true && !knownProcessExit;
        await api.commit(async tx => {
          const draft = await tx.doc(WorkerState);
          const request = draft.requests[api.taskId];
          if (request) { request.status = "consumed"; request.uncertain = uncertain; }
        }, ctx);
        w.emit({ type: "worker.diagnostic", sessionId: String(api.conversationId),
          data: { text: `${effect.name} task ${api.taskId}: ${uncertain ? "failed; effects may be uncertain" : knownProcessExit ? `process exited ${exitCode}` : "completed"}` } });
        // The nested call reports interruptions without executing its effect again.
        return { ...text(typeof result.structuredOutput === "string" ? result.structuredOutput : JSON.stringify(result.structuredOutput ?? result.diagnostics)), isError: result.isError,
          ...(effect.structuredOutputSchema && result.structuredOutput !== undefined ? { structuredOutput: result.structuredOutput } : {}) };
      } });
    }
    tools.push(defineTool({ name: "report_progress", description: "Publish a short advisory milestone; do not include secrets, raw logs, source excerpts, or reasoning.",
      parameters: CheckpointInputSchema.toJSONSchema(), replay: "safe", execute: async (args, api, ctx) => {
        const checkpoint = CheckpointInputSchema.parse(args);
        if (Buffer.byteLength(JSON.stringify(checkpoint)) > 4096) throw new Error("checkpoint exceeds 4096 bytes");
        const state = await api.snapshot(WorkerState, ctx);
        worker().emit({ type: "message.part.updated", sessionId: String(api.conversationId),
          data: { sourceId: String(api.taskId), messageId: state!.messages[api.conversationId], checkpoint } });
        return text("Checkpoint emitted.");
      } }));
    tools.push(defineTool({ name: "write_report", description: "Validate and save the final worker report JSON to the assigned report directory.",
      parameters: obj({ json: str() }), replay: "safe", execute: async (args, api, ctx) => {
        const state = await api.snapshot(WorkerState, ctx);
        const policy = JSON.parse(state!.policies[api.conversationId]!) as FrozenPolicy;
        const report = WorkerReportSchema.parse(JSON.parse(args.json));
        if (report.execution_id !== basename(policy.reportPath)) throw new Error("report execution identity mismatch");
        const file = checkedPath(policy, join(policy.reportPath, "result.json"), true);
        mkdirSync(policy.reportPath, { recursive: true, mode: 0o700 });
        const content = JSON.stringify(report, null, 2) + "\n";
        // Exact same output is idempotent; different reports are written atomically.
        const temp = checkedPath(policy, join(policy.reportPath, `report-${randomUUID()}.tmp`), true);
        writeFileSync(temp, content, { mode: 0o600, flag: "wx" }); renameSync(temp, file);
        const summary = checkedPath(policy, join(policy.reportPath, "summary.md"), true);
        writeFileSync(summary, `# Worker report\n\n${report.summary}\n\nOutcome: ${report.outcome}\n\n${report.gaps.map(g => "- " + g).join("\n")}\n`, { mode: 0o600 });
        return text("Validated report and summary saved.");
      } }));
    return tools;
  }

  private async permission(tool: string, args: JsonObject, api: ToolExecutionApi, ctx: Context): Promise<void> {
    const id = String(api.taskId);
    await api.commit(async tx => {
      const state = await tx.doc(WorkerState);
      const existing = state.requests[id];
      if (existing && (existing.tool !== tool || existing.args !== JSON.stringify(args))) throw new Error("permission identity reused for different arguments");
      if (!existing) state.requests[id] = { id, taskId: api.taskId, sessionId: String(api.conversationId),
        messageId: state.messages[api.conversationId]!, tool, args: JSON.stringify(args), status: "pending", uncertain: false };
    }, ctx);
    while (true) {
      const request = (await api.snapshot(WorkerState, ctx))!.requests[id]!;
      if (request.status === "deny") throw new Error("parent denied this exact operation" +
        (request.workerExplanation === undefined ? "" : "\nParent feedback within the existing assignment: " + request.workerExplanation));
      if (request.status === "allow_once" || request.status === "consumed") return;
      await awaitWithContext(new Promise(resolve => setTimeout(resolve, 100)), ctx);
    }
  }

  private emit(event: BackendEvent): void {
    this.events.push({ seq: ++this.sequence, event });
    if (this.events.length > 256) this.events.shift();
  }
  eventPage(after: number) { return { events: this.events.filter(e => e.seq > after), cursor: this.sequence,
    gap: this.events.length > 0 && after < this.events[0]!.seq - 1 }; }

  async createSession(marker: string) {
    const id = await this.harness.commit(async tx => {
      const state = await tx.doc(WorkerState);
      if (state.markers[marker]) return state.markers[marker]!;
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      state.markers[marker] = String(conversation.id);
      return String(conversation.id);
    }, context);
    return { id, backendId: this.backendId, workspace: this.workspace };
  }
  async findCreatedSession(marker: string) {
    const id = (await this.harness.snapshot(WorkerState, context))?.markers[marker];
    return id ? { id, backendId: this.backendId, workspace: this.workspace } : null;
  }
  private async conversation(id: string): Promise<Conversation> {
    const conversation = await this.harness.conversation(Number(id) as ConversationId, context);
    if (!conversation) throw new Error("unknown conversation");
    return conversation;
  }
  async submitTurn(input: { sessionId: string; messageId: string; prompt: string; launchContract: ManagedLaunchContract }) {
    const policy = JSON.parse(input.launchContract.configContent) as FrozenPolicy;
    assertFrozenEffectiveConfig(policy, input.launchContract);
    if (policyNeutralConfigHash(this.contract) !== policyNeutralConfigHash(input.launchContract)) throw new Error("follow-up changes frozen worker configuration");
    const conversation = await this.conversation(input.sessionId);
    await this.harness.commit(async tx => {
      const state = await tx.doc(WorkerState);
      const existing = state.turns[input.messageId];
      if (existing) {
        if (existing.sessionId !== input.sessionId || existing.promptHash !== effectiveConfigHash(input.prompt)) throw new Error("dispatch identity conflict");
        return;
      }
      if (state.cancelled[input.sessionId]) delete state.cancelled[input.sessionId];
      state.policies[input.sessionId] = input.launchContract.configContent;
      state.messages[input.sessionId] = input.messageId;
      await configure(tx, Number(input.sessionId) as ConversationId, { model: { provider: policy.model.provider_id, modelId: policy.model.model_id },
        cwd: policy.workspace, instructions: "Use write_report to save the final result.json. " + input.prompt,
        maxTurns: policy.maxTurns });
      const submissionId = await conversation.submit(tx, { type: "input", content: input.prompt, requestId: input.messageId, whenBusy: "reject" });
      state.turns[input.messageId] = { sessionId: input.sessionId, submissionId, promptHash: effectiveConfigHash(input.prompt) };
    }, context);
  }
  async inspectTurn(sessionId: string, messageId: string): Promise<TurnObservation> {
    const state = await this.harness.snapshot(WorkerState, context);
    const turn = state?.turns[messageId];
    if (!turn || turn.sessionId !== sessionId) return { submitted: false, assistantMessageIds: [], activeTools: 0,
      status: "unknown", pendingRequests: [], finished: false, error: null };
    const submission = await this.harness.submission(turn.submissionId as SubmissionId, context);
    const record = await submission!.status(context);
    const live = await this.harness.snapshot(LiveDoc, Number(sessionId) as ConversationId, context);
    const pendingRequests: PendingRequest[] = [];
    for (const request of Object.values(state!.requests)) {
      if (request.sessionId !== sessionId || request.messageId !== messageId || request.status !== "pending") continue;
      const task = await this.harness.getTask(request.taskId as TaskId, context);
      if (task?.state.status === "terminal") continue;
      pendingRequests.push({ id: request.id, sessionId, type: "permission", api: "v2",
        detail: { tool: request.tool, args: JSON.parse(request.args), messageId } });
    }
    const finished = record.status === "done" || record.status === "unanswered";
    const aborted = record.status === "unanswered" && record.reason === "aborted";
    return { submitted: true, assistantMessageIds: record.status === "done" && "answer" in record && record.answer ? [String(record.answer)] : [],
      activeTools: live ? Object.values(live.tools ?? []).filter(t => !t.entry).length : 0,
      status: finished ? "idle" : "busy", statusOmitted: finished, pendingRequests,
      finished, uncertainEffects: Object.values(state!.requests).filter(r => r.sessionId === sessionId && r.messageId === messageId && r.uncertain).slice(0, 64).map(r => ({ requestId: r.id, tool: r.tool })),
      error: record.status === "unanswered" ? aborted ? JSON.stringify({ name: "MessageAbortedError" }) : record.reason + ": " + (live?.runFailure?.detail ?? "") : null };
  }
  async reply(request: PendingRequest, reply: "allow_once" | "deny", workerExplanation?: string) {
    validateWorkerExplanation(reply, workerExplanation);
    await this.harness.commit(async tx => {
      const state = await tx.doc(WorkerState);
      const current = state.requests[request.id];
      if (!current || current.sessionId !== request.sessionId || state.messages[current.sessionId] !== current.messageId ||
        (request.detail as { messageId?: unknown } | null)?.messageId !== current.messageId || state.cancelled[current.sessionId]) throw new Error("stale or wrong-session permission request");
      if (current.status !== "pending") {
        if ((current.status === reply || current.status === "consumed" && reply === "allow_once") && current.workerExplanation === workerExplanation) return;
        throw new Error("permission response conflict");
      }
      current.status = reply;
      if (workerExplanation !== undefined) current.workerExplanation = workerExplanation;
    }, context);
    this.emit({ type: "worker.diagnostic", sessionId: request.sessionId,
      data: { text: `permission ${request.id}: ${reply}` } });
  }
  async abort(sessionId: string) {
    await this.harness.commit(async tx => {
      const state = await tx.doc(WorkerState);
      state.cancelled[sessionId] = true;
      // Approval may already have produced an effect when cancellation interrupts its completion record.
      for (const request of Object.values(state.requests))
        if (request.sessionId === sessionId && request.status === "allow_once") request.uncertain = true;
    }, context);
    await (await this.conversation(sessionId)).abort(context, { background: true });
    return true;
  }
  async resume() {
    const state = await this.harness.snapshot(WorkerState, context);
    for (const id of Object.keys(state?.cancelled ?? {})) await (await this.conversation(id)).abort(context, { background: true });
    this.harness.resume();
  }
  async readResult(sessionId: string, messageId: string) {
    const state = await this.harness.snapshot(WorkerState, context);
    const turn = state?.turns[messageId];
    if (!turn || turn.sessionId !== sessionId) throw new Error("unknown exact turn");
    const result = await (await this.harness.submission(turn.submissionId as SubmissionId, context))!.status(context);
    let output = "";
    if (result.status === "done" && "answer" in result && result.answer) {
      const entry = await (await this.conversation(sessionId)).commit(tx => tx.entry(result.answer!), context);
      output = entry?.model?.flatMap(m => m.role === "assistant" ? m.content.filter(b => b.type === "text").map(b => b.text) : []).join("\n") ?? "";
    }
    return { text: output, structured: null };
  }
  close() { return this.harness.close(context); }
}
