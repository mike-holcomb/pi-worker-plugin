import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, realpathSync, readdirSync, mkdirSync, rmSync, writeFileSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { shellPreflight } from "../shell-preflight.js";
import { createShellEnvironment } from "../pi-env.js";
import { SqliteTaskStore } from "../store.js";
import { SupervisorService } from "../service.js";
import { ArtifactStore } from "../artifacts.js";

function directory() { return realpathSync(mkdtempSync(join(tmpdir(), "pi-env-"))); }

test("private preflight identifies absent PATH node without login activation or environment disclosure", async () => {
  const root = directory();
  try {
    const probe = await shellPreflight(root, { PATH: "", SECRET_SENTINEL: "credential-sentinel", HOME: "/not-inherited", TMPDIR: "/not-inherited" });
    assert.equal(probe.shell.status, "ready");
    assert.equal(probe.node.status, "missing");
    assert.equal(probe.private_temp.status, "ready");
    assert.equal(probe.local_ipc.status, "ready");
    assert.doesNotMatch(JSON.stringify(probe), /credential-sentinel|not-inherited/);
    assert.deepEqual(readdirSync(root), []);
    const selected = await shellPreflight(root, { PATH: dirname(process.execPath) });
    assert.equal(selected.node.status, "ready");
    assert.equal(selected.node.version, process.versions.node);
    assert.equal(selected.node.matches_supervisor, true);
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const mode of ["unsupported", "failed", "timeout"] as const) {
  test(`preflight classifies ${mode} executable and redacts its output`, async () => {
    const root = directory(); const bin = join(root, "bin"); mkdirSync(bin);
    try {
      writeFileSync(join(bin, "node"), '#!/bin/bash\n' + (mode === "unsupported" ? "printf 'v22.0.0\\n'" :
        mode === "failed" ? "printf 'credential-sentinel' >&2; exit 2" : "exec /bin/sleep 5"), { mode: 0o700 });
      const probe = await shellPreflight(root, { PATH: bin });
      assert.equal(probe.node.status, mode);
      if (mode === "failed") assert.equal(probe.node.exit_code, 2);
      assert.doesNotMatch(JSON.stringify(probe), /credential-sentinel/);
      assert.deepEqual(readdirSync(root), ["bin"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("preflight reports private-directory and Unix IPC limits and always removes its directory", async () => {
  const root = directory();
  try {
    const blocked = join(root, "file"); writeFileSync(blocked, "existing");
    const failed = await shellPreflight(blocked);
    assert.equal(failed.private_temp.status, "failed");
    const long = join(root, "x".repeat(100)); mkdirSync(long);
    const probe = await shellPreflight(long, { PATH: dirname(process.execPath) });
    assert.equal(probe.private_temp.status, "ready");
    assert.equal(probe.local_ipc.error_code, "ENAMETOOLONG");
    assert.deepEqual(readdirSync(long), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("shared environment enforces private ownership and symlink restrictions without inherited HOME or TMPDIR", () => {
  const root = directory();
  try {
    const env = createShellEnvironment(root, { PATH: "", HOME: "/external", TMPDIR: "/external", TOKEN: "secret" });
    assert.equal(env.HOME, join(root, ".home"));
    assert.equal(env.TMPDIR, join(root, ".tmp"));
    assert.equal(env.TOKEN, undefined);
    assert.equal(statSync(env.TMPDIR!).mode & 0o777, 0o700);
    rmSync(env.TMPDIR!, { recursive: true });
    symlinkSync(env.HOME!, env.TMPDIR!);
    assert.throws(() => createShellEnvironment(root), /owned and private/);
    rmSync(env.TMPDIR!); mkdirSync(env.TMPDIR!, { mode: 0o755 });
    assert.throws(() => createShellEnvironment(root), /owned and private/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("health preflight is opt-in and labels supervisor environment separately from local doctor", async () => {
  const root = directory(); const previousState = process.env.PI_AGENTS_STATE_DIR; const previousPath = process.env.PATH;
  process.env.PI_AGENTS_STATE_DIR = root;
  const store = new SqliteTaskStore(join(root, "store.sqlite"));
  try {
    const service = new SupervisorService(store, new ArtifactStore(join(root, "artifacts")));
    const normal = await service.handle("health", {}) as Record<string, unknown>;
    assert.equal(normal.shell_preflight, undefined);
    process.env.PATH = "";
    const health = await service.handle("health", { shell_preflight: true }) as { shell_preflight: { source: string; node: { status: string } } };
    assert.equal(health.shell_preflight.source, "daemon");
    assert.equal(health.shell_preflight.node.status, "missing");
    await assert.rejects(service.handle("health", { shell_preflight: true, command: "arbitrary" }), /Unrecognized key/);
    assert.ok(!readdirSync(root).some(name => name.startsWith("preflight-")));
  } finally {
    store.close();
    if (previousState === undefined) delete process.env.PI_AGENTS_STATE_DIR; else process.env.PI_AGENTS_STATE_DIR = previousState;
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});
