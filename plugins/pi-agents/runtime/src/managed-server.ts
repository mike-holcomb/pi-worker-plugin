import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { stateDirectory } from "./config.js";
import { PI_VERSION, type ManagedLaunchContract } from "./launch-config.js";
import { PiBackend } from "./pi-backend.js";
import { rpcRequest } from "./rpc.js";
export { freezeManagedLaunch } from "./launch-config.js";
export type Owner = { pid: number; birth: string; instanceId: string };
export function processBirth(pid: number): string | null {
  try { return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; }
  catch (error) {
    try { process.kill(pid, 0); } catch (probe) { if ((probe as NodeJS.ErrnoException).code === "ESRCH") return null; }
    throw new Error(`cannot inspect live process ${pid}: ${String(error)}`);
  }
}
export function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") return false; throw e; }
}
export function readOwner(directory: string): Owner | null {
  const file = join(directory, "owner", "record.json");
  if (!existsSync(file)) return null;
  const owner = JSON.parse(readFileSync(file, "utf8")) as Owner;
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 2 || !owner.birth || !owner.instanceId) throw new Error("invalid worker ownership record");
  return owner;
}
export function ownedAlive(owner: Owner): boolean {
  const birth = processBirth(owner.pid);
  if (birth && birth !== owner.birth) throw new Error("worker PID was reused; refusing to signal or reopen");
  return birth !== null;
}
async function terminateOwner(owner: Owner): Promise<boolean> {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (!ownedAlive(owner) && !groupAlive(owner.pid)) return true;
    // The authenticated worker owns this detached group; a reused PID never reaches here.
    try { process.kill(-owner.pid, signal); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!ownedAlive(owner) && !groupAlive(owner.pid)) return true;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  return !ownedAlive(owner) && !groupAlive(owner.pid);
}

/** Cold cancellation recovery never opens Pi storage or starts scheduling. */
export async function recordedWorkerStopper(backendId: string, instanceId: string): Promise<(() => Promise<boolean>) | null> {
  if (!/^backend_[A-Za-z0-9_-]+$/.test(backendId)) return null;
  const directory = join(stateDirectory(), "workers", backendId);
  const owner = readOwner(directory);
  const stoppedFile = join(directory, "stopped-owner.json");
  const recorded = owner ?? (existsSync(stoppedFile) ? JSON.parse(readFileSync(stoppedFile, "utf8")) as Owner : null);
  if (!recorded || recorded.instanceId !== instanceId) return null;
  if (ownedAlive(recorded)) {
    try {
      const identity = await rpcRequest(directory, "identity", {}, 1000) as Owner;
      if (identity.instanceId !== instanceId || identity.pid !== recorded.pid || identity.birth !== recorded.birth) return null;
    } catch { return null; }
  }
  return () => terminateOwner(recorded);
}
export async function reconcileDeadOwner(directory: string): Promise<void> {
  const owner = readOwner(directory);
  if (owner && ownedAlive(owner)) throw new Error("worker owner is alive; reconnect instead of reopening storage");
  if (owner && !await terminateOwner(owner)) throw new Error("abandoned worker process group still exists");
  rmSync(join(directory, "owner"), { recursive: true, force: true });
  rmSync(join(directory, "connection.json"), { force: true });
  // Socket deletion is generation-scoped when live; here owner death is proven.
  const { rpcSocketPath } = await import("./rpc.js");
  rmSync(rpcSocketPath(directory), { force: true });
}
export type ManagedServerOptions = { workspace: string; backendId: string; launchContract: ManagedLaunchContract;
  startupTimeoutMs?: number; suspendScheduling?: boolean; onDiagnostic?: (bytes: Buffer) => void };
async function openManagedServer(options: ManagedServerOptions) {
  if (process.platform === "win32") throw new Error("Pi workers currently require POSIX process groups");
  const directory = join(stateDirectory(), "workers", options.backendId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let owner = readOwner(directory);
  if (!owner || !ownedAlive(owner)) {
    if (existsSync(join(directory, "owner")) && !owner) throw new Error("worker ownership election is incomplete; observe before retrying");
    await reconcileDeadOwner(directory);
    const temp = join(directory, `launch-${randomUUID()}.json`);
    writeFileSync(temp, JSON.stringify({ backendId: options.backendId, contract: options.launchContract, suspendScheduling: options.suspendScheduling ?? false }), { mode: 0o600, flag: "wx" });
    // Each contender carries its own launch; only the elected process may open Pi storage.
    const child = spawn(process.execPath, [(existsSync(fileURLToPath(new URL("./cli.js", import.meta.url))) ? fileURLToPath(new URL("./cli.js", import.meta.url)) : fileURLToPath(import.meta.url)), "worker", "run", directory, temp], {
      cwd: options.workspace, detached: true, stdio: "ignore", env: process.env });
    child.on("error", () => {}); child.unref();
    const deadline = Date.now() + (options.startupTimeoutMs ?? 15000);
    while (Date.now() < deadline) {
      owner = readOwner(directory);
      if (owner) {
        try { await rpcRequest(directory, "identity", {}, 500); break; } catch { /* startup is still pending */ }
      }
      if (child.exitCode !== null && !owner) throw new Error("Pi worker exited before ownership election");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!owner) throw new Error("Pi worker startup timed out");
  }
  const identity = await rpcRequest(directory, "identity", {}, 5000) as Owner;
  if (identity.instanceId !== owner.instanceId || identity.pid !== owner.pid || !ownedAlive(owner)) throw new Error("worker ownership handshake mismatch");
  const backend = new PiBackend(directory, options.onDiagnostic);
  const inspection = await backend.inspectBackend();
  if (inspection.backendId !== options.backendId || inspection.workspace !== options.workspace || inspection.version !== PI_VERSION)
    throw new Error("Pi worker binding mismatch");
  const exactOwner = owner;
  return { backendId: options.backendId, instanceId: owner.instanceId, backend,
    isAlive: () => ownedAlive(exactOwner),
    confirmAbortStopped: async (sessionId: string, messageId: string) => {
      const observed = await backend.inspectTurn(sessionId, messageId);
      const quiet = observed.finished && observed.activeTools === 0 && observed.pendingRequests.length === 0 &&
        await rpcRequest(directory, "quiet", {}, 6000) === true;
      return { observation: observed, stopped: quiet };
    },
    terminateOwned: () => terminateOwner(exactOwner),
    close: async () => {
      if (ownedAlive(exactOwner)) {
        try { await rpcRequest(directory, "close", {}, 5000); } catch { /* forced shutdown still requires exit proof */ }
      }
      if (!await terminateOwner(exactOwner)) throw new Error("owned Pi worker exit was not confirmed");
    },
  };
}

/** Only the original ChildProcess handle is accepted; signal delivery is not exit proof. */
export async function terminateOwnedChild(child: {
  pid?: number | undefined;
  exitCode: number | null; signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  once(event: "exit", listener: () => void): unknown;
  off(event: "exit", listener: () => void): unknown;
},
  waitMs = 5_000, ownsProcessGroup = false): Promise<boolean> {
  // The group ID comes only from the child we spawned detached, never disk,
  // process discovery, or a caller-provided PID. Missing/denied probes fail closed.
  const groupGone = () => {
    if (!ownsProcessGroup) return true;
    if (!child.pid) return false;
    try { process.kill(-child.pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  };
  const exited = () => (child.exitCode !== null || child.signalCode !== null) && groupGone();
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (exited()) return true;
    await new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(timer); clearInterval(poll); child.off("exit", onExit); resolve(); };
      const onExit = () => { if (exited()) finish(); };
      const timer = setTimeout(finish, waitMs);
      const poll = setInterval(onExit, Math.min(waitMs, 25));
      child.once("exit", onExit);
      try {
        if (ownsProcessGroup) { if (child.pid) process.kill(-child.pid, signal); else finish(); }
        else child.kill(signal);
      } catch { finish(); }
      if (exited()) finish();
    });
  }
  return exited();
}

/** Serialize recovery and launch as well as storage ownership election. */
export async function startManagedServer(options: ManagedServerOptions) {
  const directory = join(stateDirectory(), "workers", options.backendId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, "launch-lock");
  const deadline = Date.now() + (options.startupTimeoutMs ?? 15000);
  let acquired = false;
  while (Date.now() < deadline) {
    try { mkdirSync(lock, { mode: 0o700 }); acquired = true; break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const record = join(lock, "record.json");
      if (existsSync(record)) {
        const previous = JSON.parse(readFileSync(record, "utf8")) as Owner;
        if (!ownedAlive(previous)) { rmSync(lock, { recursive: true }); continue; }
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  if (!acquired) throw new Error("Pi worker launch election timed out");
  const birth = processBirth(process.pid);
  if (!birth) throw new Error("cannot establish launcher identity");
  writeFileSync(join(lock, "record.json"), JSON.stringify({ pid: process.pid, birth, instanceId: randomUUID() }), { mode: 0o600, flag: "wx" });
  try { return await openManagedServer(options); }
  finally { rmSync(lock, { recursive: true, force: true }); }
}
