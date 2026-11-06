import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WorkerExplanationSchema } from "./request-feedback.js";
import { z } from "zod";
import { confirmWorkerGroupQuiet } from "./owned-shell.js";
import { PiHarness } from "./pi-harness.js";
import { startRpcServer } from "./rpc.js";
import { processBirth, type Owner } from "./managed-server.js";
import { PI_VERSION, policyNeutralConfigHash, type ManagedLaunchContract } from "./launch-config.js";
import type { PendingRequest } from "./backend.js";

export async function runWorker(directory: string, launchFile: string): Promise<void> {
  const lock = join(directory, "owner");
  // The kernel elects the only Pi storage owner before any database is opened.
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) { rmSync(launchFile, { force: true }); throw error; }
  let worker: PiHarness | undefined;
  let server: Awaited<ReturnType<typeof startRpcServer>> | undefined;
  const birth = processBirth(process.pid);
  if (!birth) throw new Error("cannot establish worker process identity");
  const owner: Owner = { pid: process.pid, birth, instanceId: randomUUID() };
  writeFileSync(join(lock, "record.json"), JSON.stringify(owner), { mode: 0o600, flag: "wx" });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await worker?.close();
    if (!await confirmWorkerGroupQuiet()) throw new Error("worker children did not stop");
    await server?.close();
    writeFileSync(join(directory, "stopped-owner.json"), JSON.stringify(owner), { mode: 0o600 });
    rmSync(lock, { recursive: true, force: true });
  };
  try {
    const launch = JSON.parse(readFileSync(launchFile, "utf8")) as { backendId: string; contract: ManagedLaunchContract; suspendScheduling?: boolean };
    rmSync(launchFile);
    worker = await PiHarness.open(directory, launch.contract, launch.backendId);
    const exact = z.object({ sessionId: z.string().regex(/^\d+$/), messageId: z.string().min(1) });
    server = await startRpcServer(directory, async (method, raw) => {
      switch (method) {
        case "identity": return owner;
        case "inspection": return { version: PI_VERSION, dependencyDigest: "pi-durable-" + PI_VERSION,
          backendId: launch.backendId, workspace: worker!.workspace,
          configurationDigest: policyNeutralConfigHash(launch.contract), supportedForExecution: true,
          capabilities: { callerAssignedMessageId: true, permissionRequests: true, questionRequests: false,
            structuredOutput: false, sessionRecovery: true, progressCheckpoints: true, workerDenialContext: true } };
        case "create": return worker!.createSession(z.object({ marker: z.string().min(1) }).parse(raw).marker);
        case "find": return worker!.findCreatedSession(z.object({ marker: z.string().min(1) }).parse(raw).marker);
        case "turn": {
          const p = exact.parse(raw);
          const turn = await worker!.inspectTurn(p.sessionId, p.messageId);
          // A successful shell may leave background children. Stop them before reporting
          // completion, so finalization cannot release a workspace still being changed.
          if (turn.finished && turn.activeTools === 0 && !await confirmWorkerGroupQuiet())
            throw new Error("finished worker turn still has running children");
          return turn;
        }
        case "result": { const p = exact.parse(raw); return worker!.readResult(p.sessionId, p.messageId); }
        case "events": return worker!.eventPage(z.object({ after: z.number().int().nonnegative() }).parse(raw).after);
        case "submit": {
          const p = exact.extend({ prompt: z.string().min(1), launchContract: z.object({
            configContent: z.string(), effectiveConfigSha256: z.string(), reportPath: z.string(),
          }) }).parse(raw);
          await worker!.submitTurn(p); return { acknowledged: true };
        }
        case "reply": {
          const p = z.object({ request: z.object({ id: z.string(), sessionId: z.string(),
            type: z.literal("permission"), api: z.enum(["legacy", "v2"]), detail: z.unknown() }), reply: z.enum(["allow_once", "deny"]), workerExplanation: WorkerExplanationSchema.optional() }).parse(raw);
          await worker!.reply(p.request as PendingRequest, p.reply, p.workerExplanation); return { acknowledged: true };
        }
        case "abort": {
          const result = await worker!.abort(z.object({ sessionId: z.string() }).parse(raw).sessionId);
          return await confirmWorkerGroupQuiet() && result;
        }
        case "quiet": return confirmWorkerGroupQuiet();
        case "close": setTimeout(() => { void close().then(() => process.exit(0)); }, 10); return { closing: true };
        default: throw new Error("unknown private worker operation");
      }
    });
    if (!launch.suspendScheduling) await worker.resume();
    process.once("SIGTERM", () => { void close().then(() => process.exit(0)); });
    process.once("SIGINT", () => { void close().then(() => process.exit(0)); });
  } catch (error) { await close(); throw error; }
}
