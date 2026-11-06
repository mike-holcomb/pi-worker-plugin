import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startManagedServer, readOwner, processBirth } from "../managed-server.js";
import { effectiveConfigHash, type FrozenPolicy } from "../launch-config.js";
import { PiBackend } from "../pi-backend.js";
import { rpcRequest } from "../rpc.js";
import { ExecutionCoordinator } from "../coordinator.js";
import { SupervisorService } from "../service.js";
import { SqliteTaskStore } from "../store.js";
import { ArtifactStore } from "../artifacts.js";

type Reply = { content?: string; tool?: string; args?: object };
async function fixture(profile: FrozenPolicy["profile"] = "bounded-inspect") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-worker-")));
  const workspace = join(root, "project"); mkdirSync(workspace);
  const replies: Reply[] = [];
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); requests.push(input);
    assert.equal(input.model, "fixture-model");
    const response = replies.shift() ?? { content: "done" };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const delta = response.tool ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`,
      type: "function", function: { name: response.tool, arguments: JSON.stringify(response.args ?? {}) } }] } : { role: "assistant", content: response.content };
    res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: response.tool ? "tool_calls" : "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const policy: FrozenPolicy = { version: "1.5.0", workspace, reportPath: join(root, "reports", "exec_test"), profile,
    model: { provider_id: "local", model_id: "fixture-model", destination: "local" }, readRoots: [workspace],
    writes: [{ path: join(workspace, "effects.txt"), kind: "file" }], maxTurns: 50,
    providers: { local: { kind: "openai-compatible", base_url: `http://127.0.0.1:${port}/v1`, models: {
      "fixture-model": { context_window: 32000, max_tokens: 4096, reasoning: false, input: ["text"] } } } } };
  const contract = () => ({ configContent: JSON.stringify(policy), effectiveConfigSha256: effectiveConfigHash(policy), reportPath: policy.reportPath });
  const previousState = process.env.PI_AGENTS_STATE_DIR;
  const previousConfig = process.env.PI_AGENTS_CONFIG;
  process.env.PI_AGENTS_STATE_DIR = root;
  return { root, workspace, policy, contract, replies, requests, async close() {
    if (previousState === undefined) delete process.env.PI_AGENTS_STATE_DIR; else process.env.PI_AGENTS_STATE_DIR = previousState;
    if (previousConfig === undefined) delete process.env.PI_AGENTS_CONFIG; else process.env.PI_AGENTS_CONFIG = previousConfig;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  } };
}
async function until<T>(read: () => Promise<T>, predicate: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) { const value = await read(); if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error("expected worker state was not reached");
}

test("owned Pi worker elects once, reconnects, dispatches exactly once, and serves recovered results", { timeout: 30000 }, async () => {
  const fx = await fixture();
  let lease: Awaited<ReturnType<typeof startManagedServer>> | undefined;
  try {
    const options = { workspace: fx.workspace, backendId: "backend_test", launchContract: fx.contract() };
    const leases = await Promise.all([startManagedServer(options), startManagedServer(options)]);
    lease = leases[0]; assert.equal(lease.instanceId, leases[1]!.instanceId);
    const backend = lease.backend;
    const session = await backend.createSession("marker");
    const input = { sessionId: session.id, messageId: "msg_one", prompt: "Answer", providerId: "local", modelId: "fixture-model", agent: "bounded-inspect", launchContract: fx.contract() };
    await backend.submitTurn(input); await backend.submitTurn(input);
    const finished = await until(() => backend.inspectTurn(session.id, "msg_one"), t => t.finished);
    assert.equal(finished.error, null);
    assert.equal(fx.requests.length, 1);
    const reconnect = await startManagedServer(options);
    assert.equal(reconnect.instanceId, lease.instanceId);
    assert.equal((await reconnect.backend.readResult(session.id, "msg_one")).text, "done");
    await lease.close(); lease = undefined;
    lease = await startManagedServer(options);
    assert.notEqual(lease.instanceId, reconnect.instanceId);
    assert.deepEqual(await lease.backend.findCreatedSession("marker"), session);
    await lease.backend.submitTurn(input);
    assert.equal(fx.requests.length, 1);
  } finally { await lease?.close(); await fx.close(); }
});

test("worker crash during an approved shell effect never replays it, and a new attempt needs fresh permission", { timeout: 30000 }, async () => {
  const fx = await fixture("bounded-build");
  fx.replies.push({ tool: "bash", args: { command: "printf x >> effects.txt; sleep 60" } },
    { tool: "bash", args: { command: "printf y >> effects.txt" } }, { content: "done" });
  let lease: Awaited<ReturnType<typeof startManagedServer>> | undefined;
  try {
    const options = { workspace: fx.workspace, backendId: "backend_test", launchContract: fx.contract() };
    lease = await startManagedServer(options);
    const session = await lease.backend.createSession("marker");
    await lease.backend.submitTurn({ sessionId: session.id, messageId: "msg_one", prompt: "Run bounded command", providerId: "local", modelId: "fixture-model", agent: "bounded-build", launchContract: fx.contract() });
    const pending = await until(() => lease!.backend.inspectTurn(session.id, "msg_one"), t => t.pendingRequests.length === 1);
    await lease.backend.replyToRequest(pending.pendingRequests[0]!, "allow_once");
    await until(async () => existsSync(join(fx.workspace, "effects.txt")), Boolean);
    const directory = join(fx.root, "workers", "backend_test");
    const owner = readOwner(directory)!;
    process.kill(owner.pid, "SIGKILL");
    await until(async () => processBirth(owner.pid), birth => birth === null);
    lease = await startManagedServer(options);
    const next = await until(() => lease!.backend.inspectTurn(session.id, "msg_one"), t => t.pendingRequests.length === 1);
    assert.notEqual(next.pendingRequests[0]!.id, pending.pendingRequests[0]!.id);
    assert.equal(next.uncertainEffects?.[0]?.requestId, pending.pendingRequests[0]!.id);
    assert.equal(readFileSync(join(fx.workspace, "effects.txt"), "utf8"), "x");
    await lease.backend.replyToRequest(next.pendingRequests[0]!, "allow_once");
    await until(() => lease!.backend.inspectTurn(session.id, "msg_one"), t => t.finished);
    assert.equal(readFileSync(join(fx.workspace, "effects.txt"), "utf8"), "xy");
  } finally { await lease?.close(); await fx.close(); }
});

test("active Pi cancellation stops a shell and its descendants; cancelled work stays stopped on reopen", { timeout: 30000 }, async () => {
  const fx = await fixture("bounded-build");
  fx.replies.push({ tool: "bash", args: { command: "printf x > effects.txt; sleep 60 & wait" } });
  let lease: Awaited<ReturnType<typeof startManagedServer>> | undefined;
  try {
    const options = { workspace: fx.workspace, backendId: "backend_test", launchContract: fx.contract() };
    lease = await startManagedServer(options);
    const session = await lease.backend.createSession("marker");
    const input = { sessionId: session.id, messageId: "msg_one", prompt: "Run", providerId: "local", modelId: "fixture-model", agent: "bounded-build", launchContract: fx.contract() };
    await lease.backend.submitTurn(input);
    const pending = await until(() => lease!.backend.inspectTurn(session.id, "msg_one"), t => t.pendingRequests.length === 1);
    await lease.backend.replyToRequest(pending.pendingRequests[0]!, "allow_once");
    await until(async () => existsSync(join(fx.workspace, "effects.txt")), Boolean);
    assert.equal(await lease.backend.abortSession(session.id), true);
    const turn = await lease.backend.inspectTurn(session.id, "msg_one");
    assert.equal(turn.activeTools, 0);
    assert.match(turn.error!, /MessageAbortedError/);
    assert.equal(turn.uncertainEffects?.[0]?.requestId, pending.pendingRequests[0]!.id);
    const requestCount = fx.requests.length;
    await lease.close();
    lease = await startManagedServer({ ...options, suspendScheduling: true });
    assert.match((await lease.backend.inspectTurn(session.id, "msg_one")).error!, /MessageAbortedError/);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(fx.requests.length, requestCount);
    assert.equal(readFileSync(join(fx.workspace, "effects.txt"), "utf8"), "x");
  } finally { await lease?.close(); await fx.close(); }
});

test("normal completion stops background shell children before advertising a finished turn", { timeout: 30000 }, async () => {
  const fx = await fixture("bounded-build");
  fx.replies.push({ tool: "bash", args: { command: "sleep 60 >/dev/null 2>&1 & printf '%s' \"$!\" > effects.txt" } }, { content: "done" });
  let lease: Awaited<ReturnType<typeof startManagedServer>> | undefined;
  try {
    lease = await startManagedServer({ workspace: fx.workspace, backendId: "backend_test", launchContract: fx.contract() });
    const session = await lease.backend.createSession("marker");
    await lease.backend.submitTurn({ sessionId: session.id, messageId: "msg_one", prompt: "Run", providerId: "local", modelId: "fixture-model", agent: "bounded-build", launchContract: fx.contract() });
    const pending = await until(() => lease!.backend.inspectTurn(session.id, "msg_one"), t => t.pendingRequests.length === 1);
    await lease.backend.replyToRequest(pending.pendingRequests[0]!, "allow_once");
    await until(() => lease!.backend.inspectTurn(session.id, "msg_one"), t => t.finished);
    const pid = Number(readFileSync(join(fx.workspace, "effects.txt"), "utf8"));
    assert.ok(pid > 1);
    await until(async () => processBirth(pid), birth => birth === null);
  } finally { await lease?.close(); await fx.close(); }
});

test("cold cancellation recovery can reopen storage with scheduling suspended before aborting the exact conversation", { timeout: 30000 }, async () => {
  const fx = await fixture("bounded-build");
  fx.replies.push({ tool: "bash", args: { command: "printf x > effects.txt; sleep 60" } });
  let lease: Awaited<ReturnType<typeof startManagedServer>> | undefined;
  try {
    const options = { workspace: fx.workspace, backendId: "backend_test", launchContract: fx.contract() };
    lease = await startManagedServer(options);
    const session = await lease.backend.createSession("marker");
    await lease.backend.submitTurn({ sessionId: session.id, messageId: "msg_one", prompt: "Run", providerId: "local", modelId: "fixture-model", agent: "bounded-build", launchContract: fx.contract() });
    const pending = await until(() => lease!.backend.inspectTurn(session.id, "msg_one"), t => t.pendingRequests.length === 1);
    await lease.backend.replyToRequest(pending.pendingRequests[0]!, "allow_once");
    await until(async () => existsSync(join(fx.workspace, "effects.txt")), Boolean);
    const owner = readOwner(join(fx.root, "workers", "backend_test"))!;
    process.kill(owner.pid, "SIGKILL"); await until(async () => processBirth(owner.pid), birth => birth === null);
    const requestCount = fx.requests.length;
    lease = await startManagedServer({ ...options, suspendScheduling: true });
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(fx.requests.length, requestCount);
    assert.equal(await lease.backend.abortSession(session.id), true);
    const proof = await lease.confirmAbortStopped(session.id, "msg_one");
    assert.equal(proof.stopped, true);
    assert.match(proof.observation.error!, /MessageAbortedError/);
    assert.equal(fx.requests.length, requestCount);
  } finally { await lease?.close(); await fx.close(); }
});

test("supervisor captures valid Pi report evidence, preserves parent review, and continues in the same conversation", { timeout: 30000 }, async () => {
  const fx = await fixture();
  const config = { schema_version: 1, project_roots: [fx.workspace], read_roots: [], providers: fx.policy.providers,
    models: { local: fx.policy.model }, limits: { concurrency: 2, queue_timeout_seconds: 60, execution_timeout_seconds: 60, finalization_timeout_seconds: 10, artifact_bytes: 1000000 } };
  const configPath = join(fx.root, "config.json"); writeFileSync(configPath, JSON.stringify(config)); process.env.PI_AGENTS_CONFIG = configPath;
  const store = new SqliteTaskStore(join(fx.root, "state.sqlite"));
  const artifacts = new ArtifactStore(join(fx.root, "artifacts"));
  let coordinator = new ExecutionCoordinator(store, artifacts);
  let service = new SupervisorService(store, artifacts, coordinator);
  const packet = { title: "Inspect", objective: "Inspect workspace", tier: "lightweight", authoritative_inputs: [], context: { verified_facts: [], rejected_assumptions: [], exclusions: [] }, allowed_writes: [], acceptance_criteria: [], checks: [], constraints: [], stop_conditions: [], shared_resources: [] };
  try {
    const task = await service.handle("start_task", { scope_id: "scope", idempotency_key: "start-fixture-123456", workspace: { path: fx.workspace }, model: { profile: "local" }, profile: "bounded-inspect", limits: { queue_timeout_seconds: 60, execution_timeout_seconds: 60 }, packet }) as { taskId: string; executionId: string };
    const report = { schema_version: 2, task_id: task.taskId, execution_id: task.executionId, outcome: "completed", summary: "Inspected workspace", coverage: ["workspace"], gaps: [], findings: [], changes: [], checks: [], blockers: [], next_action: "Parent review" };
    fx.replies.push({ tool: "write_report", args: { json: JSON.stringify(report) } }, { content: "done" });
    await coordinator.start();
    const completed = await until(async () => store.get("scope", task.taskId)!, t => t.phase === "completed");
    assert.equal(completed.reportValidity, "valid");
    assert.equal(completed.reviewStatus, "pending");
    assert.ok(store.artifactsForExecution(task.executionId).length >= 3);
    await coordinator.close();
    coordinator = new ExecutionCoordinator(store, artifacts); service = new SupervisorService(store, artifacts, coordinator);
    const follow = await service.handle("continue_task", { scope_id: "scope", task_id: task.taskId, predecessor_execution_id: task.executionId,
      expected_revision: completed.revision, idempotency_key: "follow-fixture-123456", context_mode: "resume", packet }) as { executionId: string };
    fx.replies.push({ tool: "write_report", args: { json: JSON.stringify({ ...report, execution_id: follow.executionId }) } }, { content: "follow done" });
    await coordinator.start();
    const continued = await until(async () => store.get("scope", task.taskId)!, t => t.phase === "completed");
    assert.equal(continued.sessionId, completed.sessionId);
    assert.notEqual(continued.userMessageId, completed.userMessageId);
    assert.equal(continued.reportValidity, "valid");
  } finally { await coordinator.close(); store.close(); await fx.close(); }
});
