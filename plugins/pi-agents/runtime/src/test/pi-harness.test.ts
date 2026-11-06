import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { PiHarness } from "../pi-harness.js";
import { effectiveConfigHash, type FrozenPolicy, type ManagedLaunchContract } from "../launch-config.js";
import { createWorkerModels } from "../pi-models.js";
import { checkedPath, createBoundedEnv } from "../pi-env.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

export function policyFixture(profile: FrozenPolicy["profile"] = "bounded-inspect") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-harness-")));
  const workspace = join(root, "project"); mkdirSync(workspace);
  const policy: FrozenPolicy = { version: "1.5.0", workspace, reportPath: join(root, "exec_test"), profile,
    model: { provider_id: "fake", model_id: "model", destination: "local" }, readRoots: [workspace],
    writes: [{ path: join(workspace, "output.txt"), kind: "file" }], maxTurns: 50,
    providers: { fake: { kind: "openai-compatible", base_url: "http://127.0.0.1:8124/v1",
      models: { model: { context_window: 32000, max_tokens: 4096, reasoning: false, input: ["text"] } } } } };
  const contract = (): ManagedLaunchContract => ({ configContent: JSON.stringify(policy),
    effectiveConfigSha256: effectiveConfigHash(policy), reportPath: policy.reportPath });
  const fake = fauxProvider({ provider: "fake", models: [{ id: "model" }] });
  const models = createModels(); models.setProvider(fake.provider);
  return { root, workspace, policy, contract, fake, models };
}
async function until<T>(read: () => Promise<T>, predicate: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) { const value = await read(); if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error("expected state was not reached");
}
const report = { schema_version: 2, task_id: "task_test", execution_id: "exec_test", outcome: "completed",
  summary: "Read the assigned input.", coverage: ["input.txt"], gaps: [], findings: [], changes: [], checks: [], blockers: [], next_action: "Parent review" };

test("Pi admits one exact turn, runs coding/progress/report tools, and recovers its result", async () => {
  const fx = policyFixture(); writeFileSync(join(fx.workspace, "input.txt"), "alpha");
  const checkpoint = { stage: "verifying", summary: "Read input", completed: [], remaining: [], blocker: null, evidence_refs: [] };
  fx.fake.setResponses([
    fauxAssistantMessage([fauxToolCall("read", { path: "input.txt" }), fauxToolCall("report_progress", checkpoint)], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("write_report", { json: JSON.stringify(report) })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Finished reading alpha."),
  ]);
  let worker = await PiHarness.open(join(fx.root, "storage"), fx.contract(), "backend_test", fx.models);
  try {
    const session = await worker.createSession("marker");
    assert.deepEqual(await worker.createSession("marker"), session);
    const input = { sessionId: session.id, messageId: "msg_one", prompt: "Read input", launchContract: fx.contract() };
    await worker.submitTurn(input); await worker.submitTurn(input);
    const turn = await until(() => worker.inspectTurn(session.id, "msg_one"), v => v.finished);
    assert.equal(turn.error, null);
    assert.equal(fx.fake.state.callCount, 3);
    assert.equal(JSON.parse(readFileSync(join(fx.policy.reportPath, "result.json"), "utf8")).task_id, "task_test");
    assert.ok(existsSync(join(fx.policy.reportPath, "summary.md")));
    assert.equal(worker.eventPage(0).events.length, 1);
    assert.match((await worker.readResult(session.id, "msg_one")).text, /alpha/);
    await worker.close();
    worker = await PiHarness.open(join(fx.root, "storage"), fx.contract(), "backend_test", fx.models);
    assert.deepEqual(await worker.findCreatedSession("marker"), session);
    await worker.submitTurn(input);
    assert.equal((await worker.inspectTurn(session.id, "msg_one")).finished, true);
    assert.equal(fx.fake.state.callCount, 3);
    await assert.rejects(worker.submitTurn({ ...input, prompt: "Different prompt" }), /identity conflict/);
  } finally { await worker.close(); rmSync(fx.root, { recursive: true, force: true }); }
});

test("pending permission survives reopen; allow-once executes one scoped write", async () => {
  const fx = policyFixture("bounded-build");
  fx.fake.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "output.txt", content: "approved" })], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
  let worker = await PiHarness.open(join(fx.root, "storage"), fx.contract(), "backend_test", fx.models);
  try {
    const session = await worker.createSession("marker");
    await worker.submitTurn({ sessionId: session.id, messageId: "msg_one", prompt: "Write output", launchContract: fx.contract() });
    const pending = await until(() => worker.inspectTurn(session.id, "msg_one"), v => v.pendingRequests.length === 1);
    assert.equal(existsSync(join(fx.workspace, "output.txt")), false);
    const request = pending.pendingRequests[0]!;
    await worker.close();
    worker = await PiHarness.open(join(fx.root, "storage"), fx.contract(), "backend_test", fx.models);
    await worker.resume();
    const reopened = await until(() => worker.inspectTurn(session.id, "msg_one"), v => v.pendingRequests.length === 1);
    assert.equal(reopened.pendingRequests[0]!.id, request.id);
    await assert.rejects(worker.reply({ ...request, sessionId: "999" }, "allow_once"), /wrong-session/);
    await worker.reply(request, "allow_once"); await worker.reply(request, "allow_once");
    await until(() => worker.inspectTurn(session.id, "msg_one"), v => v.finished);
    assert.equal(readFileSync(join(fx.workspace, "output.txt"), "utf8"), "approved");
    await assert.rejects(worker.reply(request, "deny"), /conflict/);
  } finally { await worker.close(); rmSync(fx.root, { recursive: true, force: true }); }
});

test("network effects wait for durable permission and expose bounded results without leaking the query into diagnostics", async () => {
  const fx = policyFixture("bounded-build");
  const previousFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async input => { calls.push(String(input)); return new Response("network result"); };
  fx.fake.setResponses([fauxAssistantMessage([fauxToolCall("websearch", { query: "fixture search" })], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
  let worker = await PiHarness.open(join(fx.root, "storage"), fx.contract(), "backend_test", fx.models);
  try {
    const session = await worker.createSession("network");
    await worker.submitTurn({ sessionId: session.id, messageId: "network", prompt: "Search", launchContract: fx.contract() });
    const pending = await until(() => worker.inspectTurn(session.id, "network"), v => v.pendingRequests.length === 1);
    assert.equal(calls.length, 0);
    await worker.close();
    worker = await PiHarness.open(join(fx.root, "storage"), fx.contract(), "backend_test", fx.models);
    await worker.resume();
    await worker.reply(pending.pendingRequests[0]!, "allow_once");
    await until(() => worker.inspectTurn(session.id, "network"), v => v.finished);
    assert.deepEqual(calls, ["https://html.duckduckgo.com/html/?q=fixture+search"]);
    const diagnostic = JSON.stringify(worker.eventPage(0).events);
    assert.match(diagnostic, /completed/);
    assert.doesNotMatch(diagnostic, /fixture search|network result/);
  } finally { await worker.close(); globalThis.fetch = previousFetch; rmSync(fx.root, { recursive: true, force: true }); }
});

test("denied operations have no effect and abort withdraws waiting permissions", async () => {
  const fx = policyFixture("bounded-build");
  fx.fake.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: "touch output.txt" })], { stopReason: "toolUse" }), fauxAssistantMessage("denied")]);
  const worker = await PiHarness.open(join(fx.root, "storage"), fx.contract(), "backend_test", fx.models);
  try {
    const s = await worker.createSession("one");
    await worker.submitTurn({ sessionId: s.id, messageId: "one", prompt: "Try command", launchContract: fx.contract() });
    const pending = await until(() => worker.inspectTurn(s.id, "one"), v => v.pendingRequests.length > 0);
    await worker.reply(pending.pendingRequests[0]!, "deny");
    await until(() => worker.inspectTurn(s.id, "one"), v => v.finished);
    assert.equal(existsSync(join(fx.workspace, "output.txt")), false);
    fx.fake.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 20" })], { stopReason: "toolUse" })]);
    await worker.submitTurn({ sessionId: s.id, messageId: "two", prompt: "Try again", launchContract: fx.contract() });
    await until(() => worker.inspectTurn(s.id, "two"), v => v.pendingRequests.length > 0);
    await worker.abort(s.id);
    const aborted = await worker.inspectTurn(s.id, "two");
    assert.match(aborted.error!, /MessageAbortedError/);
    assert.deepEqual(aborted.pendingRequests, []);
  } finally { await worker.close(); rmSync(fx.root, { recursive: true, force: true }); }
});

test("filesystem policy rejects inspection writes, undeclared targets, aliases, and symlink escapes", async () => {
  const fx = policyFixture();
  try {
    assert.throws(() => checkedPath(fx.policy, "output.txt", true), /outside/);
    fx.policy.profile = "bounded-build";
    assert.equal(checkedPath(fx.policy, "output.txt", true), join(fx.workspace, "output.txt"));
    assert.throws(() => checkedPath(fx.policy, "undeclared.txt", true), /outside/);
    assert.throws(() => checkedPath(fx.policy, "~/secret"), /explicit/);
    symlinkSync(fx.root, join(fx.workspace, "escape"));
    assert.throws(() => checkedPath(fx.policy, "escape/secret"), /symlink/);
    const env = createBoundedEnv(fx.policy);
    assert.throws(() => env.writeFile("../secret", "secret", BACKGROUND_CONTEXT), /outside/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("inspection can list, glob, and search files without shell access", async () => {
  const fx = policyFixture();
  writeFileSync(join(fx.workspace, "input.txt"), "alpha\nbeta\n");
  fx.fake.setResponses([
    fauxAssistantMessage([fauxToolCall("list", {}), fauxToolCall("glob", { pattern: "**/*.txt" }), fauxToolCall("grep", { query: "beta" })], { stopReason: "toolUse" }),
    messages => {
      const toolResults = messages.messages.filter(m => m.role === "toolResult");
      assert.equal(toolResults.length, 3);
      assert.ok(toolResults.every(m => !m.isError));
      assert.match(JSON.stringify(toolResults), /beta/);
      return fauxAssistantMessage("inspected");
    },
  ]);
  const worker = await PiHarness.open(join(fx.root, "storage"), fx.contract(), "backend_test", fx.models);
  try {
    const s = await worker.createSession("one");
    await worker.submitTurn({ sessionId: s.id, messageId: "one", prompt: "Inspect", launchContract: fx.contract() });
    const result = await until(() => worker.inspectTurn(s.id, "one"), t => t.finished);
    assert.equal(result.error, null);
  } finally { await worker.close(); rmSync(fx.root, { recursive: true, force: true }); }
});

test("native providers use explicit endpoints and environment keys without auth-file discovery", () => {
  const fx = policyFixture();
  try {
    for (const kind of ["openai", "anthropic", "google", "openrouter"] as const) {
      fx.policy.providers = { native: { kind, base_url: "http://127.0.0.1:8000/v1", api_key_env: "PI_TEST_KEY" } };
      // Register first, then select an actual catalog entry.
      const factories = createWorkerModels;
      const ids = { openai: "gpt-5-mini", anthropic: "claude-sonnet-4-5", google: "gemini-2.5-flash", openrouter: "openai/gpt-5-mini" };
      fx.policy.model = { provider_id: "native", model_id: ids[kind], destination: "local" };
      const models = factories(fx.policy, { PI_TEST_KEY: "test-only" });
      assert.equal(models.getModel("native", ids[kind])!.baseUrl, "http://127.0.0.1:8000/v1");
      assert.throws(() => factories(fx.policy, {}), /missing provider credential/);
    }
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

for (const kind of ["openai", "anthropic", "google", "openrouter"] as const) {
  test(`native ${kind} SDK streams through its frozen endpoint with mocked transport`, async (t) => {
    const fx = policyFixture();
    const ids = { openai: "gpt-5-mini", anthropic: "claude-sonnet-4-5", google: "gemini-2.5-flash", openrouter: "openai/gpt-5-mini" };
    fx.policy.providers = { native: { kind, base_url: "http://127.0.0.1:8000", api_key_env: "PI_TEST_KEY" } };
    fx.policy.model = { provider_id: "native", model_id: ids[kind], destination: "local" };
    const requests: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input); requests.push(url);
      let events: Array<{ event?: string; data: unknown }>;
      if (kind === "anthropic") events = [
        { event: "message_start", data: { type: "message_start", message: { id: "msg", type: "message", role: "assistant", model: ids[kind], content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } } },
        { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } } },
        { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
        { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
        { event: "message_stop", data: { type: "message_stop" } },
      ];
      else if (kind === "google") events = [{ data: { candidates: [{ content: { role: "model", parts: [{ text: "hello" }] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } } }];
      else if (kind === "openai") events = [
        { event: "response.created", data: { type: "response.created", response: { id: "resp", status: "in_progress", output: [] } } },
        { event: "response.output_item.added", data: { type: "response.output_item.added", output_index: 0, item: { id: "item", type: "message", role: "assistant", content: [] } } },
        { event: "response.content_part.added", data: { type: "response.content_part.added", item_id: "item", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } } },
        { event: "response.output_text.delta", data: { type: "response.output_text.delta", item_id: "item", output_index: 0, content_index: 0, delta: "hello" } },
        { event: "response.output_item.done", data: { type: "response.output_item.done", output_index: 0, item: { id: "item", type: "message", role: "assistant", content: [{ type: "output_text", text: "hello", annotations: [] }] } } },
        { event: "response.completed", data: { type: "response.completed", response: { id: "resp", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } } },
      ];
      else events = [{ data: { id: "resp", choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }] } }, { data: { id: "resp", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] } }];
      return new Response(events.map(e => (e.event ? `event: ${e.event}\n` : "") + `data: ${JSON.stringify(e.data)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
    });
    try {
      const models = createWorkerModels(fx.policy, { PI_TEST_KEY: "test-only" });
      const answer = await models.complete(models.getModel("native", ids[kind])!, { messages: [{ role: "user", content: "hi", timestamp: 0 }] });
      assert.equal(answer.stopReason, "stop", answer.errorMessage);
      assert.equal(answer.content.filter(b => b.type === "text").map(b => b.text).join(""), "hello");
      assert.ok(requests.length > 0);
      assert.ok(requests.every(url => url.startsWith("http://127.0.0.1:8000/")));
    } finally { rmSync(fx.root, { recursive: true, force: true }); }
  });
}
