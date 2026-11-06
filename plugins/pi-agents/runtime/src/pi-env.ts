import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { ownedExec } from "./owned-shell.js";
import type { Context } from "@earendil-works/chord/context";
import type { ShellExecOptions } from "@earendil-works/pi-durable/env";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { lstatSync, mkdirSync, realpathSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { FrozenPolicy } from "./launch-config.js";

const inside = (path: string, root: string) => path === root || path.startsWith(root + sep);

/** Reject symlinks along the entire path, including ancestors of new outputs. */
export function checkedPath(policy: FrozenPolicy, raw: string, write = false): string {
  if (raw.startsWith("~") || raw.startsWith("file:")) throw new Error("use an explicit filesystem path");
  const path = resolve(policy.workspace, raw);
  let current = path;
  while (true) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`symlink access is not permitted: ${current}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const roots = write ? [
    { path: policy.reportPath, kind: "directory" },
    ...(policy.profile === "bounded-build" ? policy.writes : []),
  ] : [...policy.readRoots, ...(policy.inputPaths ?? []), ...(policy.profile === "bounded-build" ? policy.writes.map(w => w.path) : []), policy.reportPath].map(path => ({ path, kind: "directory" }));
  if (!roots.some(r => r.kind === "file" ? path === r.path : inside(path, r.path))) throw new Error("path is outside the frozen worker policy");
  return path;
}

/** File tools are scoped here; arbitrary shell commands require explicit parent approval. */
export function createBoundedEnv(policy: FrozenPolicy): ExecutionEnv {
  const safeEnv: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TERM"]) if (process.env[key]) safeEnv[key] = process.env[key];
  safeEnv.HOME = join(policy.reportPath, ".home");
  safeEnv.TMPDIR = join(policy.reportPath, ".tmp");
  mkdirSync(safeEnv.HOME, { recursive: true, mode: 0o700 });
  mkdirSync(safeEnv.TMPDIR, { recursive: true, mode: 0o700 });
  const base = new NodeExecutionEnv({ cwd: policy.workspace, shellEnv: safeEnv });
  const writes = new Set(["writeFile", "appendFile", "truncateFile", "flushFile", "remove", "createDir"]);
  const reads = new Set(["watch", "absolutePath", "openTextLineReader", "readTextFile", "readTextLines", "readBinaryFile", "openBinaryReader", "fileInfo", "listDir", "openDirReader", "canonicalPath", "exists"]);
  return new Proxy(base, { get(target, prop) {
    if (prop === "exec") return (command: string | readonly string[], options: ShellExecOptions | undefined, ctx: Context) => {
      if (policy.profile !== "bounded-build") throw new Error("shell is disabled for bounded-inspect");
      const cwd = checkedPath(policy, options?.cwd ?? policy.workspace);
      return ownedExec(command, options, ctx, cwd, safeEnv);
    };
    if (prop === "createTempDir") return async () => ({ ok: true, value: mkdtempSync(join(safeEnv.TMPDIR!, "pi-")) });
    if (prop === "createTempFile") return async (options?: { suffix?: string }) => {
      const dir = mkdtempSync(join(safeEnv.TMPDIR!, "pi-"));
      const file = join(dir, `output${options?.suffix?.replace(/[^a-zA-Z0-9.]/g, "") ?? ""}`);
      writeFileSync(file, "", { mode: 0o600 }); return { ok: true, value: file };
    };
    const value = Reflect.get(target, prop);
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => {
      if (prop === "exec" && policy.profile !== "bounded-build") throw new Error("shell execution is disabled for bounded-inspect");
      if (prop === "watch") throw new Error("file watches are unavailable to worker tools");
      if (prop === "renameFile") { checkedPath(policy, String(args[0]), true); checkedPath(policy, String(args[1]), true); }
      else if (writes.has(String(prop)) || reads.has(String(prop))) checkedPath(policy, String(args[0]), writes.has(String(prop)));
      return Reflect.apply(value, target, args);
    };
  } });
}
