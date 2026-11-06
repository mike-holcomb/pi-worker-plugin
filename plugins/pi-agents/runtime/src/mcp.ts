import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { WorkerExplanationSchema } from "./request-feedback.js";
import { z } from "zod";
import { ProgressReadSchema } from "./progress.js";
import { TaskPacketSchema, ReviewSchema } from "./contracts.js";
import { rpcRequest } from "./rpc.js";
import { stateDirectory } from "./config.js";
import { startDaemon } from "./daemon.js";
import { PrepareReviewSchema } from "./review-preparation.js";

const Id = z.string().min(1);
const Key = z.string().min(16).max(128);
const Revision = z.number().int().positive();
const Scope = { scope_id: Id };

function result(value: unknown) {
  const structuredContent = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : { value };
  const raw = JSON.stringify(structuredContent);
  const text = raw.length > 8000 ? `${raw.slice(0, 7950)}... [read structured content for full response]` : raw;
  return { structuredContent, content: [{ type: "text" as const, text }] };
}

export function createMcpServer(call: (method: string, params: unknown) => Promise<unknown>): McpServer {
  const server = new McpServer({ name: "pi-agents", version: "0.2.0" });
  server.registerTool("pi_health", {
    description: "Read toolkit and configured backend health without inference.",
    inputSchema: z.object({ backend_id: Id.optional(), shell_preflight: z.boolean().optional() }).strict(),
    annotations: { readOnlyHint: true },
  }, async (input) => result(await call("health", input)));
  server.registerTool("pi_start_task", {
    description: "Admit one bounded assignment; dry_run validates without dispatch.",
    inputSchema: z.object({
      ...Scope,
      idempotency_key: Key.optional(),
      workspace: z.object({ path: Id, access: z.enum(["exclusive", "shared_read"]).default("exclusive") }).strict(),
      model: z.union([
        z.object({ provider_id: Id, model_id: Id }).strict(),
        z.object({ profile: Id }).strict(),
      ]),
      profile: z.enum(["bounded-build", "bounded-inspect"]),
      limits: z.object({ queue_timeout_seconds: z.number().int().positive(), execution_timeout_seconds: z.number().int().positive() }).strict(),
      packet: TaskPacketSchema,
      dry_run: z.boolean().optional(),
    }).strict().refine((value) => value.dry_run || Boolean(value.idempotency_key), "idempotency_key is required for launch"),
  }, async (input) => result(await call("start_task", input)));
  server.registerTool("pi_get_task", {
    description: "Read a compact task snapshot and material events.",
    inputSchema: z.object({ ...Scope, task_id: Id, execution_id: Id.optional(), after_cursor: z.number().int().min(0).optional(),
      event_detail_cursor: Id.optional(), diagnostic_cursor: Id.optional() }).strict(),
    annotations: { readOnlyHint: true },
  }, async (input) => result(await call("get_task", input)));
  server.registerTool("pi_get_progress", {
    description: "Read bounded unseen worker checkpoints for one exact execution without inference.",
    inputSchema: ProgressReadSchema,
    annotations: { readOnlyHint: true },
  }, async (input) => {
    const value = await call("get_progress", input) as Record<string, unknown>;
    return { structuredContent: value, content: [{ type: "text" as const,
      text: "Read structuredContent for the bounded, advisory worker progress delta." }] };
  });
  server.registerTool("pi_list_tasks", {
    description: "Recover task identities in a coordination scope.",
    inputSchema: z.object({ ...Scope, states: z.array(Id).optional(), limit: z.number().int().min(1).max(100).default(20), page_cursor: Id.optional() }).strict(),
    annotations: { readOnlyHint: true },
  }, async (input) => result(await call("list_tasks", input)));
  server.registerTool("pi_wait_tasks", {
    description: "Wait briefly for material changes; timeout never cancels work.",
    inputSchema: z.object({ ...Scope, targets: z.array(z.object({ task_id: Id, after_cursor: z.number().int().min(0).default(0), execution_id: Id.optional(), after_progress_cursor: Id.max(512).optional() }).strict()).min(1).max(16), timeout_ms: z.number().int().min(0).max(30_000).default(20_000) }).strict(),
    annotations: { readOnlyHint: true },
  }, async (input) => result(await call("wait_tasks", input)));
  server.registerTool("pi_continue_task", {
    description: "Continue a resolved task in its exact recorded session or fresh context.",
    inputSchema: z.object({ ...Scope, task_id: Id, predecessor_execution_id: Id, expected_revision: Revision, idempotency_key: Key,
      context_mode: z.enum(["resume", "fresh"]), packet: TaskPacketSchema }).strict(),
  }, async (input) => result(await call("continue_task", input)));
  server.registerTool("pi_cancel_task", {
    description: "Record a cancellation request; confirmation is reported separately.",
    inputSchema: z.object({ ...Scope, task_id: Id, execution_id: Id, reason: Id, expected_revision: Revision, idempotency_key: Key }).strict(),
  }, async (input) => result(await call("cancel_task", input)));
  server.registerTool("pi_respond_to_request", {
    description: "Reply once to a current permission or question request.",
    inputSchema: z.object({ ...Scope, task_id: Id, execution_id: Id, request_id: Id, request_revision: Revision,
      reply: z.union([z.enum(["allow_once", "deny"]), z.array(z.array(Id))]), authorization_basis: Id, worker_explanation: WorkerExplanationSchema.optional(), idempotency_key: Key }).strict(),
  }, async (input) => result(await call("respond_to_request", input)));
  server.registerTool("pi_read_artifact", {
    description: "Read a bounded range of an immutable artifact.",
    inputSchema: z.object({ ...Scope, task_id: Id, execution_id: Id, artifact_id: Id,
      byte_offset: z.number().int().min(0).default(0), max_bytes: z.number().int().min(1).max(65_536).default(16_384),
      encoding: z.enum(["auto", "text", "base64"]).default("auto") }).strict(),
    annotations: { readOnlyHint: true },
  }, async (input) => ({ structuredContent: await call("read_artifact", input) as Record<string, unknown>,
    content: [{ type: "text" as const, text: "Read structuredContent for the bounded artifact bytes, encoding, hash, and pagination metadata." }] }));
  server.registerTool("pi_record_review", {
    description: "Append the parent's evidence-based review decision.",
    inputSchema: z.object({ ...Scope, task_id: Id, execution_id: Id, expected_revision: Revision, idempotency_key: Key, review: ReviewSchema }).strict(),
  }, async (input) => result(await call("record_review", input)));
  server.registerTool("pi_prepare_review", {
    description: "Prepare bounded exact-execution review criteria and artifact citations; parent verification remains required.",
    inputSchema: PrepareReviewSchema,
    annotations: { readOnlyHint: true },
  }, async (input) => {
    try {
      return { structuredContent: await call("prepare_review", input) as Record<string, unknown>,
        content: [{ type: "text" as const, text: "Read structuredContent for review preparation; collect all pages and inspect cited evidence before deciding acceptance." }] };
    } catch (error) {
      // RPC reconstructs errors as plain Error objects; preserve their fields
      // explicitly because the MCP SDK only exposes the message of thrown errors.
      const known = error && typeof error === "object"
        ? error as { code?: unknown; message?: unknown; retry?: unknown; details?: unknown } : null;
      return { isError: true, ...result({ error: {
        code: typeof known?.code === "string" ? known.code : "INTERNAL",
        message: typeof known?.message === "string" ? known.message : String(error),
        ...(typeof known?.retry === "string" ? { retry: known.retry } : {}),
        ...(known?.details !== undefined ? { details: known.details } : {}),
      } }) };
    }
  });
  return server;
}

export async function runMcp(): Promise<void> {
  await startDaemon(process.argv[1]);
  const server = createMcpServer((method, params) => rpcRequest(stateDirectory(), method, params,
    method === "wait_tasks" && params && typeof params === "object" && "timeout_ms" in params &&
      typeof params.timeout_ms === "number" ? params.timeout_ms + 1_500 : 30_000));
  await server.connect(new StdioServerTransport());
}
