import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createShellEnvironment, checkedPath } from "./pi-env.js";
import { ownedExec } from "./owned-shell.js";
import type { FrozenPolicy } from "./launch-config.js";

/** Synthetic tooling only; no model, network, installs, environment dumps, or user project inputs. */
export async function evaluateShell() {
  // A short, newly allocated private fixture permits a controlled IPC-positive comparison.
  // This is a test fixture, never a production TMPDIR fallback.
  const root = mkdtempSync(join(realpathSync("/tmp"), "pi-shell-eval-"));
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve("tsx/package.json")), "dist", "cli.mjs");
  const results: Array<{ scenario: string; classification: string; exit_code: number | null; error_code: string | null; error_message: string | null;
    stdout: string; stderr: string; file_tool_symlink_rejected: boolean | null }> = [];
  try {
    for (const layout of ["clean", "symlink"] as const) {
      const workspace = join(root, layout); mkdirSync(workspace);
      writeFileSync(join(workspace, "sample.test.ts"), "import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nconst value: number = 3;\ntest('synthetic content',()=>assert.equal(value,3));\n");
      const reportPath = join(root, `report-${layout}`);
      const env = createShellEnvironment(reportPath, { PATH: "" });
      let commandCli = cli; let rejected: boolean | null = null;
      if (layout === "symlink") {
        const modules = resolve(dirname(cli), "../..");
        symlinkSync(modules, join(workspace, "node_modules"), "dir");
        commandCli = join(workspace, "node_modules", "tsx", "dist", "cli.mjs");
        const policy = { workspace, reportPath, readRoots: [workspace], writes: [], profile: "bounded-build" } as unknown as FrozenPolicy;
        try { checkedPath(policy, commandCli); rejected = false; } catch { rejected = true; }
      }
      for (const selected of [false, true]) {
        let stdout = "", stderr = "";
        const result = await ownedExec([selected ? process.execPath : "node", commandCli, "--test", "sample.test.ts"],
          { timeout: 5, onOutput: (text, _context, info) => {
            if (info.stream === "stderr") stderr = (stderr + text).slice(0, 4096);
            else stdout = (stdout + text).slice(0, 4096);
          } }, BACKGROUND_CONTEXT, workspace, env);
        const errorCode = result.ok ? null : result.error.code;
        const exitCode = result.ok ? result.value.exitCode : null;
        results.push({ scenario: `${layout}-${selected ? "selected-node" : "minimal-path"}`,
          classification: errorCode === "spawn_error" ? "executable_missing" : errorCode ? "effect_uncertain" :
            exitCode === 0 ? "passed" : /EACCES|EPERM|ENAMETOOLONG/.test(stderr) ? "temp_or_ipc_unavailable" :
              /MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/.test(stderr) ? "dependency_access" : "check_failed",
          exit_code: exitCode, error_code: errorCode, error_message: result.ok ? null : result.error.message.slice(0, 4096), stdout, stderr, file_tool_symlink_rejected: rejected });
      }
    }
    return results;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = await evaluateShell(); process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  if (results.filter(result => result.scenario.endsWith("selected-node")).some(result => result.classification !== "passed")) process.exitCode = 1;
}
