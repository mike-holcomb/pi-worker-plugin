import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ownedExec } from "../owned-shell.js";

test("signalled shell remains an uncertain effect while an observed nonzero exit remains a known result", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-shell-exit-"));
  try {
    const command = "printf x > partial.txt; kill -TERM $$";
    const interrupted = await ownedExec(command, { timeout: 2 }, BACKGROUND_CONTEXT, root, {});
    assert.equal(interrupted.ok, false);
    if (!interrupted.ok) assert.equal(interrupted.error.code, "aborted");
    assert.equal(readFileSync(join(root, "partial.txt"), "utf8"), "x");
    const failed = await ownedExec("exit 3", { timeout: 2 }, BACKGROUND_CONTEXT, root, {});
    assert.equal(failed.ok, true);
    if (failed.ok) assert.equal(failed.value.exitCode, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
