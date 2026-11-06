import { spawn, execFileSync, spawnSync } from "node:child_process";
import type { Context } from "@earendil-works/chord/context";
import { ok, err, ExecutionError, type ShellExecOptions, type ShellExecResult, type Result } from "@earendil-works/pi-durable/env";

/** Commands inherit the detached worker group, so worker death cannot hide tool descendants. */
export function cleanupWorkerGroup(): void {
  const rows = execFileSync("ps", ["-eo", "pid=,pgid=,stat="], { encoding: "utf8" }).trim().split("\n").map(row => row.trim().split(/\s+/));
  const me = rows.find(row => Number(row[0]) === process.pid);
  if (Number(me?.[1]) !== process.pid) return; // Only an elected detached worker owns a group.
  for (const row of rows) if (Number(row[1]) === process.pid && Number(row[0]) !== process.pid && !row[2]?.startsWith("Z")) {
    try { process.kill(Number(row[0]), "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
}

/** Confirm quiescence before the supervisor releases an execution's resources. */
export async function confirmWorkerGroupQuiet(): Promise<boolean> {
  const deadline = Date.now() + 5000;
  do {
    cleanupWorkerGroup();
    const probe = spawnSync("ps", ["-eo", "pid=,pgid=,stat="], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) throw new Error("cannot confirm worker process group");
    const rows = probe.stdout.trim().split("\n")
      .map(row => row.trim().split(/\s+/));
    if (!rows.some(row => Number(row[1]) === process.pid && Number(row[0]) !== process.pid && Number(row[0]) !== probe.pid && !row[2]?.startsWith("Z"))) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  return false;
}

export async function ownedExec(command: string | readonly string[], options: ShellExecOptions | undefined,
  context: Context, cwd: string, env: NodeJS.ProcessEnv): Promise<Result<ShellExecResult, ExecutionError>> {
  if (context.abortSignal?.aborted) return err(new ExecutionError("aborted", "command aborted"));
  const argv = typeof command === "string" ? ["/bin/bash", "--noprofile", "--norc", "-c", command] : [...command];
  if (!argv.length) return err(new ExecutionError("spawn_error", "empty command"));
  return new Promise(resolve => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env, detached: false, stdio: ["ignore", "pipe", "pipe"] });
    let aborted = false; let callbackError: Error | null = null;
    const stop = () => {
      aborted = true;
      cleanupWorkerGroup();
      // A live shell's descendants are discovered from parent edges, never caller-provided PIDs.
      try {
        const rows = execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n")
          .map(row => row.trim().split(/\s+/).map(Number));
        const owned = new Set<number>([child.pid!]);
        for (let changed = true; changed;) { changed = false; for (const [pid, parent] of rows)
          if (parent && owned.has(parent) && pid && !owned.has(pid)) { owned.add(pid); changed = true; } }
        for (const pid of [...owned].reverse()) { try { process.kill(pid, "SIGKILL"); } catch {} }
      } catch { child.kill("SIGKILL"); }
    };
    context.abortSignal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, (options?.timeout ?? 1800) * 1000);
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream].setEncoding("utf8");
      child[stream].on("data", (chunk: string) => { try { options?.onOutput?.(chunk, context, { stream }); }
        catch (error) { callbackError = error as Error; stop(); } });
    }
    const finish = (result: Result<ShellExecResult, ExecutionError>) => {
      clearTimeout(timer); context.abortSignal?.removeEventListener("abort", stop); resolve(result);
    };
    child.once("error", error => finish(err(new ExecutionError("spawn_error", error.message))));
    child.once("close", code => finish(callbackError ? err(new ExecutionError("unknown", callbackError.message)) :
      aborted ? err(new ExecutionError("aborted", "command interrupted; effects may be uncertain")) : ok({ exitCode: code ?? 1 })));
  });
}
