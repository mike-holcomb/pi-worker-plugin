import { mkdtempSync, realpathSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { PiHarness } from "./pi-harness.js";
import { WorkerReportSchema } from "./contracts.js";
import { effectiveConfigHash, type FrozenPolicy } from "./launch-config.js";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Scripted real harness effects; timing describes this synthetic parent, not live-model performance. */
export async function evaluateApprovals(batched: boolean, parentDelayMs = 5) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-approvals-")));
  const workspace = join(root, "project"); mkdirSync(workspace);
  const policy: FrozenPolicy = { version: "1.5.0", workspace, reportPath: join(root, "exec_evaluation"), profile: "bounded-build",
    model: { provider_id: "fake", model_id: "model", destination: "local" }, readRoots: [workspace],
    writes: [{ path: join(workspace, "output.txt"), kind: "file" }], maxTurns: 50,
    providers: { fake: { kind: "openai-compatible", base_url: "http://127.0.0.1:8124/v1",
      models: { model: { context_window: 32000, max_tokens: 4096, reasoning: false, input: ["text"] } } } } };
  const contract = { configContent: JSON.stringify(policy), effectiveConfigSha256: effectiveConfigHash(policy), reportPath: policy.reportPath };
  const fake = fauxProvider({ provider: "fake", models: [{ id: "model" }] });
  const models = createModels(); models.setProvider(fake.provider);
  const check = `${quote(process.execPath)} -e ${quote("require('node:assert/strict').equal(require('node:fs').readFileSync('output.txt','utf8'),'final\\n')")}`;
  let checkPassed = false;
  const report = { schema_version: 2, task_id: "task_evaluation", execution_id: "exec_evaluation", outcome: "completed",
    summary: "Wrote the expected output and checked its content.", coverage: ["output.txt"], gaps: [], findings: [],
    changes: [{ path: "output.txt", description: "Expected final content" }], checks: [{ id: "content", status: "passed",
      exit_code: 0, evidence: ["Scripted content assertion exited 0."], explanation: "Local content assertion" }], blockers: [], next_action: "Parent review" };
  fake.setResponses([
    ...(batched ? [fauxAssistantMessage([fauxToolCall("write", { path: "output.txt", content: "final\n" })], { stopReason: "toolUse" })] : [
      fauxAssistantMessage([fauxToolCall("write", { path: "output.txt", content: "first\n" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("edit", { path: "output.txt", oldText: "first", newText: "second" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("edit", { path: "output.txt", oldText: "second", newText: "final" })], { stopReason: "toolUse" }),
    ]),
    fauxAssistantMessage([fauxToolCall("bash", { command: check })], { stopReason: "toolUse" }),
    context => {
      const results = context.messages.filter(message => message.role === "toolResult");
      const last = results.at(-1);
      if (last?.role === "toolResult") for (const block of last.content) {
        if (block.type === "text") {
          try { checkPassed ||= JSON.parse(block.text).exitCode === 0; } catch { /* preserve failed observation */ }
        }
      }
      return fauxAssistantMessage([fauxToolCall("write_report", { json: JSON.stringify(report) })], { stopReason: "toolUse" });
    },
    fauxAssistantMessage("Report ready for parent review."),
  ]);
  const worker = await PiHarness.open(join(root, "storage"), contract, "backend_evaluation", models);
  const counts = { file_effects: 0, shell: 0, report_writes: 0, other: 0 };
  let parentWaitMs = 0; const started = performance.now(); const seen = new Set<string>();
  try {
    const session = await worker.createSession("evaluation");
    await worker.submitTurn({ sessionId: session.id, messageId: "evaluation-turn", prompt: "Write final output, check it once, and report.", launchContract: contract });
    while (performance.now() - started < 10000) {
      const turn = await worker.inspectTurn(session.id, "evaluation-turn");
      for (const request of turn.pendingRequests) {
        if (seen.has(request.id)) continue;
        seen.add(request.id);
        const tool = (request.detail as { tool: string }).tool;
        if (tool === "write" || tool === "edit") counts.file_effects++;
        else if (tool === "bash") counts.shell++; else counts.other++;
        const waiting = performance.now(); await new Promise(resolve => setTimeout(resolve, parentDelayMs));
        parentWaitMs += performance.now() - waiting;
        await worker.reply(request, "allow_once");
      }
      if (turn.finished) {
        const totalMs = performance.now() - started;
        return { scenario: batched ? "batched" : "three_edits", requests: counts, parent_wait_ms: parentWaitMs,
          execution_ms: totalMs - parentWaitMs, elapsed_ms: totalMs,
          quality: { expected_file: readFileSync(join(workspace, "output.txt"), "utf8") === "final\n", check_passed: checkPassed,
            report_valid: WorkerReportSchema.safeParse(JSON.parse(readFileSync(join(policy.reportPath, "result.json"), "utf8"))).success },
          live_model: false, accepted_by_parent: false };
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error("approval evaluation timed out");
  } finally { await worker.close(); rmSync(root, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = [await evaluateApprovals(false), await evaluateApprovals(true)];
  process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  if (results.some(result => Object.values(result.quality).some(value => !value))) process.exitCode = 1;
}
