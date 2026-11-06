import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateApprovals } from "../approval-evaluation.js";
import { evaluateShell } from "../shell-evaluation.js";

test("batching reduces exact approvals while file, check, and report quality remain independently verified", async () => {
  const repeated = await evaluateApprovals(false), batched = await evaluateApprovals(true);
  assert.deepEqual(repeated.requests, { file_effects: 3, shell: 1, report_writes: 0, other: 0 });
  assert.deepEqual(batched.requests, { file_effects: 1, shell: 1, report_writes: 0, other: 0 });
  for (const result of [repeated, batched]) {
    assert.deepEqual(result.quality, { expected_file: true, check_passed: true, report_valid: true });
    assert.ok(result.parent_wait_ms > 0 && result.execution_ms > 0);
    assert.equal(result.live_model, false);
    assert.equal(result.accepted_by_parent, false);
  }
});

test("tsx evaluation retains first missing executable and successful selected-node results across dependency layouts", async () => {
  const results = await evaluateShell();
  assert.equal(results.length, 4);
  for (const result of results) {
    assert.equal(result.classification, result.scenario.endsWith("minimal-path") ? "executable_missing" : "passed");
    if (result.scenario.startsWith("symlink")) assert.equal(result.file_tool_symlink_rejected, true);
    if (result.classification === "passed") {
      assert.equal(result.exit_code, 0); assert.match(result.stdout, /synthetic content/);
    } else assert.equal(result.error_code, "spawn_error");
  }
});
