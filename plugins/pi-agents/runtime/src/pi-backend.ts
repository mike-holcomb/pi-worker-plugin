import type { WorkerBackend, RequestControl, PendingRequest, BackendEvent } from "./backend.js";
import type { ManagedLaunchContract } from "./launch-config.js";
import { rpcRequest } from "./rpc.js";

export class PiBackend implements WorkerBackend {
  private eventCursor = 0;
  constructor(readonly directory: string, private readonly onDiagnostic?: (bytes: Buffer) => void) {}
  private request(method: string, params: unknown, control?: RequestControl): Promise<unknown> {
    control?.signal?.throwIfAborted();
    return rpcRequest(this.directory, method, params, control?.timeoutMs ?? 5000);
  }
  async inspectBackend(control?: RequestControl) { return await this.request("inspection", {}, control) as Awaited<ReturnType<WorkerBackend["inspectBackend"]>>; }
  async createSession(marker: string, control?: RequestControl) { return await this.request("create", { marker }, control) as Awaited<ReturnType<WorkerBackend["createSession"]>>; }
  async findCreatedSession(marker: string, control?: RequestControl) { return await this.request("find", { marker }, control) as Awaited<ReturnType<WorkerBackend["findCreatedSession"]>>; }
  async submitTurn(input: Parameters<WorkerBackend["submitTurn"]>[0], control?: RequestControl) {
    if (!input.launchContract) throw new Error("Pi dispatch requires an exact launch contract");
    await this.request("submit", input, control);
  }
  async inspectTurn(sessionId: string, messageId: string, control?: RequestControl) { return await this.request("turn", { sessionId, messageId }, control) as Awaited<ReturnType<WorkerBackend["inspectTurn"]>>; }
  async readCheckpoint(event: BackendEvent, sessionId: string, messageId: string) {
    const data = event.data as { sourceId?: unknown; messageId?: unknown; checkpoint?: unknown } | null;
    if (event.sessionId !== sessionId || data?.messageId !== messageId || typeof data.sourceId !== "string") return null;
    return { sourceId: data.sourceId, checkpoint: data.checkpoint };
  }
  async *subscribeEvents(control?: RequestControl): AsyncIterable<BackendEvent> {
    let cursor = this.eventCursor;
    while (!control?.signal?.aborted) {
      const page = await this.request("events", { after: cursor }, control) as {
        events: Array<{ seq: number; event: BackendEvent }>; cursor: number; gap: boolean };
      if (page.gap) { this.eventCursor = page.cursor; throw new Error("worker event buffer gap"); }
      for (const item of page.events) {
        cursor = item.seq; this.eventCursor = cursor;
        if (item.event.type === "worker.diagnostic") {
          const data = item.event.data as { text?: unknown };
          if (typeof data?.text === "string") this.onDiagnostic?.(Buffer.from(data.text.slice(0, 2048) + "\n"));
        } else yield item.event;
      }
      cursor = page.cursor; this.eventCursor = cursor;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  async replyToRequest(request: PendingRequest, reply: "allow_once" | "deny" | string[][], control?: RequestControl, workerExplanation?: string) {
    if (Array.isArray(reply)) throw new Error("native questions are unsupported");
    await this.request("reply", { request, reply, ...(workerExplanation === undefined ? {} : { workerExplanation }) }, control);
  }
  async abortSession(sessionId: string, control?: RequestControl) { return await this.request("abort", { sessionId }, control) === true; }
  async readResult(sessionId: string, messageId: string, control?: RequestControl) { return await this.request("result", { sessionId, messageId }, control) as { text: string; structured: unknown }; }
}
