import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createServer, createConnection } from "node:net";
import { createShellEnvironment } from "./pi-env.js";

type Probe = { status: "ready" | "missing" | "unsupported" | "failed" | "timeout";
  exit_code: number | null; error_code: string | null };
const ready = (): Probe => ({ status: "ready", exit_code: 0, error_code: null });
function failure(error: unknown): Probe {
  const code = (error as NodeJS.ErrnoException)?.code;
  return { status: "failed", exit_code: null,
    error_code: typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "PROBE_FAILED" };
}

/** Fixed probes only: no caller-selected command, workspace code, or environment dump. */
async function command(argv: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Probe & { output: string }> {
  return new Promise(resolve => {
    let output = ""; let settled = false;
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const finish = (probe: Probe) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ ...probe, output }); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish({ status: "timeout", exit_code: null, error_code: "PROBE_TIMEOUT" }); }, 2000);
    child.stdout.on("data", bytes => { if (output.length < 4096) output += String(bytes).slice(0, 4096 - output.length); });
    // Drain stderr without retaining possibly sensitive executable/startup output.
    child.stderr.resume();
    child.once("error", error => finish({ ...failure(error), status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "failed" }));
    child.once("close", code => finish({ status: code === 0 ? "ready" : "failed", exit_code: code, error_code: code === 0 ? null : "PROBE_EXIT" }));
  });
}

async function ipc(path: string): Promise<Probe> {
  // Node/OS may truncate Unix socket paths; reject before binding outside the private directory.
  if (Buffer.byteLength(path) >= (process.platform === "darwin" ? 104 : 108))
    return failure({ code: "ENAMETOOLONG" });
  const server = createServer(socket => socket.end());
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "PROBE_TIMEOUT" })), 2000);
      server.once("error", error => { clearTimeout(timer); reject(error); });
      server.listen(path, () => { clearTimeout(timer); resolve(); });
    });
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(path);
      const timer = setTimeout(() => { socket.destroy(); reject({ code: "PROBE_TIMEOUT" }); }, 2000);
      socket.once("error", error => { clearTimeout(timer); socket.destroy(); reject(error); });
      socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(); });
    });
    return ready();
  } catch (error) { return failure(error); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

export async function shellPreflight(statePath: string, inherited: NodeJS.ProcessEnv = process.env) {
  const result = { shell_mode: "bash --noprofile --norc", representative_environment: true,
    shell: failure(null), node: { ...failure(null), version: null as string | null, matches_supervisor: null as boolean | null },
    private_temp: failure(null), local_ipc: failure(null) };
  let directory: string | undefined;
  try {
    mkdirSync(statePath, { recursive: true, mode: 0o700 });
    directory = mkdtempSync(join(realpathSync(statePath), "preflight-"));
    const env = createShellEnvironment(directory, inherited);
    const { output: shellOutput, ...shell } = await command(["/bin/bash", "--noprofile", "--norc", "-c", "command -v node"], directory, env);
    result.shell = shell.status === "failed" && shell.exit_code === 1 ? ready() : shell;
    const { output, ...node } = await command(["node", "--version"], directory, env);
    const version = /^v(\d+\.\d+\.\d+)\s*$/.exec(output)?.[1] ?? null;
    const [major, minor] = (version ?? "").split(".").map(Number);
    result.node = { ...node, version, matches_supervisor: null };
    if (node.status === "ready" && (major !== 24 || minor! < 15 || !version)) result.node.status = "unsupported";
    if (node.status === "ready" && shellOutput.trim()) {
      try { result.node.matches_supervisor = realpathSync(shellOutput.trim()) === realpathSync(process.execPath); } catch { /* unavailable binding */ }
    }
    try {
      const file = join(env.TMPDIR!, "probe");
      writeFileSync(file, "private", { flag: "wx", mode: 0o600 });
      if (readFileSync(file, "utf8") !== "private" || (statSync(file).mode & 0o077)) throw new Error("private temp check failed");
      result.private_temp = ready();
    } catch (error) { result.private_temp = failure(error); }
    result.local_ipc = await ipc(join(env.TMPDIR!, "p.sock"));
    return result;
  } catch (error) {
    result.private_temp = failure(error); return result;
  } finally { if (directory) rmSync(directory, { recursive: true, force: true }); }
}
