import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { ArtifactStore } from "../artifacts.js";
import { SupervisorService } from "../service.js";
import { SqliteTaskStore } from "../store.js";
import { createMcpServer } from "../mcp.js";
import { startRpcServer } from "../rpc.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "artifact-response-"));
  const store = new SqliteTaskStore(join(root, "state.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const service = new SupervisorService(store, artifacts);
  const task = store.start({ scopeId: "scope", idempotencyKey: "artifact-test-12345678", workspace: root,
    packet: {}, model: "local/model", profile: "bounded-inspect", baselineHash: "a".repeat(64), promptHash: "b".repeat(64) });
  function capture(bytes: Uint8Array, mediaType: string) {
    const entry = artifacts.captureBytes(task.executionId, bytes, mediaType, (item) => store.registerArtifact(item));
    return { scope_id: task.scopeId, task_id: task.taskId, execution_id: task.executionId, artifact_id: entry.artifactId };
  }
  return { root, store, service, capture, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("artifact MCP responses carry one body and a bounded pointer for JSON and Markdown", async () => {
  const fx = fixture();
  const server = createMcpServer((method, params) => fx.service.handle(method, params));
  const client = new Client({ name: "artifact-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    for (const [body, type] of [[JSON.stringify({ data: "x".repeat(13100) }), "application/json"],
      ["# Report\n" + "x".repeat(6300), "text/markdown"]]) {
      const request = fx.capture(Buffer.from(body!), type!);
      const response = await client.callTool({ name: "pi_read_artifact", arguments: { ...request, max_bytes: 18000 } });
      const data = response.structuredContent as { encoding: string; content: string; content_base64?: string };
      assert.equal(data.encoding, "text"); assert.equal(data.content, body);
      assert.equal(Object.hasOwn(data, "content_base64"), false);
      assert.ok(JSON.stringify(response.content).length < 250);
      assert.ok(Buffer.byteLength(JSON.stringify(response)) < Buffer.byteLength(body!) + 1000);
    }
  } finally { await client.close(); await server.close(); fx.close(); }
});

test("auto byte pagination preserves UTF-8, BOMs, invalid bytes and binary without replacements", async () => {
  const fx = fixture();
  try {
    for (const [bytes, type] of [[Buffer.from("\ufeffAé🙂終\n"), "text/plain"],
      [Buffer.from([0xff, 0x00, 0xc3]), "application/json"], [Buffer.from([0, 255, 1]), "application/octet-stream"],
      [Buffer.alloc(0), "text/plain"]] as const) {
      const request = fx.capture(bytes, type);
      for (const size of [1, 2, 5, 65536]) {
        const chunks: Buffer[] = [];
        let offset = 0;
        do {
          const result = await fx.service.handle("read_artifact", { ...request, byte_offset: offset, max_bytes: size }) as any;
          assert.equal(Object.hasOwn(result, "content"), result.encoding === "text");
          assert.equal(Object.hasOwn(result, "content_base64"), result.encoding === "base64");
          chunks.push(result.encoding === "text" ? Buffer.from(result.content) : Buffer.from(result.content_base64, "base64"));
          assert.equal(result.byte_offset, offset);
          if (result.next_offset === null) break;
          assert.ok(result.next_offset > offset); offset = result.next_offset;
        } while (true);
        assert.deepEqual(Buffer.concat(chunks), bytes);
      }
      const exact = await fx.service.handle("read_artifact", { ...request, encoding: "base64" }) as any;
      assert.deepEqual(Buffer.from(exact.content_base64, "base64"), bytes);
      assert.equal(Object.hasOwn(exact, "content"), false);
    }
    const request = fx.capture(Buffer.from("é"), "text/plain");
    await assert.rejects(fx.service.handle("read_artifact", { ...request, byte_offset: 1, encoding: "text" }),
      { code: "INVALID_INPUT", retry: "change_input" });
    await assert.rejects(fx.service.handle("read_artifact", { ...request, max_bytes: 1, encoding: "text" }), /use encoding: base64/);
    const empty = fx.capture(Buffer.alloc(0), "text/plain");
    const result = await fx.service.handle("read_artifact", empty) as any;
    assert.equal(result.content, ""); assert.equal(result.next_offset, null);
    await assert.rejects(fx.service.handle("read_artifact", { ...request, execution_id: "foreign" }), { code: "INVALID_INPUT" });
  } finally { fx.close(); }
});

test("CLI artifact export requests base64 and writes exact multichunk bytes", async () => {
  const fx = fixture();
  const bytes = Buffer.from("é🙂".repeat(20000));
  const request = fx.capture(bytes, "text/plain");
  const encodings: unknown[] = [];
  const server = await startRpcServer(fx.root, async (method, params) => {
    encodings.push((params as any).encoding); return fx.service.handle(method, params);
  });
  try {
    const output = join(fx.root, "export.txt");
    const child = spawn(process.execPath, [join(import.meta.dirname, "../cli.js"), "artifacts", "export",
      request.scope_id, request.task_id, request.execution_id, request.artifact_id, output],
      { env: { ...process.env, PI_AGENTS_STATE_DIR: fx.root }, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(code, 0, stderr);
    assert.deepEqual(readFileSync(output), bytes);
    assert.ok(encodings.length > 1); assert.ok(encodings.every((encoding) => encoding === "base64"));
  } finally { await server.close(); fx.close(); }
});
