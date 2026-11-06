import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createMcpServer } from "../mcp.js";

test("MCP client discovers twelve tools and read-only annotations, then calls health", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const server = createMcpServer(async (method, params) => {
    calls.push({ method, params });
    return { healthy: true, version: "0.2.0" };
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 12);
    assert.equal(listed.tools.find((tool) => tool.name === "pi_health")?.annotations?.readOnlyHint, true);
    assert.equal(listed.tools.find((tool) => tool.name === "pi_get_progress")?.annotations?.readOnlyHint, true);
    assert.equal(listed.tools.find((tool) => tool.name === "pi_prepare_review")?.annotations?.readOnlyHint, true);
    assert.equal(listed.tools.find((tool) => tool.name === "pi_start_task")?.annotations?.readOnlyHint, undefined);
    const response = await client.callTool({ name: "pi_health", arguments: {} });
    assert.deepEqual(response.structuredContent, { healthy: true, version: "0.2.0" });
    assert.deepEqual(calls.map((call) => call.method), ["health"]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP review preparation retains exact identity and uses a compact text pointer", async () => {
  const prepared = { execution_id: "exec_exact", items: [{ kind: "criterion", criterion: {
    id: "coverage", requirement: "Inspect sources", result: "not_checked", evidence: [] } }],
    next_cursor: null, has_more: false };
  const calls: Array<{ method: string; params: unknown }> = [];
  const server = createMcpServer(async (method, params) => { calls.push({ method, params }); return prepared; });
  const client = new Client({ name: "review-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const response = await client.callTool({ name: "pi_prepare_review", arguments: {
      scope_id: "scope", task_id: "task", execution_id: "exec_exact" } });
    assert.deepEqual(response.structuredContent, prepared);
    assert.deepEqual(calls, [{ method: "prepare_review", params: {
      scope_id: "scope", task_id: "task", execution_id: "exec_exact", max_bytes: 32768, limit: 10 } }]);
    assert.ok(JSON.stringify(response.content).length < 250);
    assert.doesNotMatch(JSON.stringify(response.content), /Inspect sources/);
  } finally { await client.close(); await server.close(); }
});

test("MCP exposes opt-in preflight and bounded denial feedback without changing audit fields", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const server = createMcpServer(async (method, params) => { calls.push({ method, params }); return { ok: true }; });
  const client = new Client({ name: "feedback-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await client.callTool({ name: "pi_health", arguments: { shell_preflight: true } });
    const reply = { scope_id: "scope", task_id: "task", execution_id: "exec", request_id: "30", request_revision: 1,
      reply: "deny", authorization_basis: "audit record", worker_explanation: "Finish the report.", idempotency_key: "mcp-denial-key-00001" };
    await client.callTool({ name: "pi_respond_to_request", arguments: reply });
    assert.deepEqual(calls, [{ method: "health", params: { shell_preflight: true } }, { method: "respond_to_request", params: reply }]);
    const oversized = await client.callTool({ name: "pi_respond_to_request", arguments: { ...reply, worker_explanation: "é".repeat(2049) } });
    assert.equal(oversized.isError, true);
    assert.equal(calls.length, 2);
  } finally { await client.close(); await server.close(); }
});
