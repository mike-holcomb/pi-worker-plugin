import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ArtifactStore } from "../artifacts.js";
import { SupervisorService } from "../service.js";
import { SqliteTaskStore, StoreConflict } from "../store.js";
import { ARTIFACT_REFERENCE_FORMAT, ReviewInputError } from "../review-input.js";
import { rpcRequest, startRpcServer } from "../rpc.js";
import { ReviewSchema } from "../contracts.js";

test("review input errors identify bad evidence and survive RPC without state or key changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-input-"));
  const store = new SqliteTaskStore(join(root, "state.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const service = new SupervisorService(store, artifacts);
  let task = store.start({ scopeId: "scope", idempotencyKey: "review-input-12345678", workspace: root,
    packet: { acceptance_criteria: [{ id: "coverage", required: true }] }, model: "local/model",
    profile: "bounded-inspect", baselineHash: "a".repeat(64), promptHash: "b".repeat(64) });
  const capture = (body: string, type: string) => artifacts.captureBytes(task.executionId, Buffer.from(body), type,
    (entry) => store.registerArtifact(entry));
  const report = capture("{}", "application/json");
  capture("Report", "text/markdown");
  const manifest = capture("[]", "application/json");
  task = store.transition(task.scopeId, task.taskId, task.revision, "finalizing", "current");
  task = store.finalize(task.scopeId, task.taskId, task.revision, "completed", "valid", manifest.sha256);
  const citation = `artifact:${report.artifactId}@sha256:${report.sha256}`;
  const review = { disposition: "accepted" as const, rationale: "Parent checked originals",
    criteria: [{ id: "coverage", result: "satisfied" as const, evidence: [citation] }],
    starting_state_sha256: task.baselineHash, final_manifest_sha256: manifest.sha256,
    freshness: "Current", integration_checks: [], coverage_limits: [], unresolved_issues: [], next_action: "Integrate" };
  const request = { scope_id: task.scopeId, task_id: task.taskId, execution_id: task.executionId,
    expected_revision: task.revision, idempotency_key: "review-rejected-key-123456", review };
  const before = store.events(task.executionId);
  const server = await startRpcServer(root, (method, params) => service.handle(method, params));
  try {
    for (const [entry, reason] of [["Parent verified the original source files.", "malformed_reference"],
      [`artifact:missing@sha256:${report.sha256}`, "unknown_artifact"],
      [`artifact:${report.artifactId}@sha256:${"f".repeat(64)}`, "hash_mismatch"]]) {
      await assert.rejects(rpcRequest(root, "record_review", { ...request,
        review: { ...review, criteria: [{ ...review.criteria[0], evidence: [citation, entry] }] } }), (error: any) => {
        assert.equal(error.code, "INVALID_INPUT"); assert.equal(error.retry, "change_input");
        assert.deepEqual(error.details, { criterion_id: "coverage", evidence_index: 1,
          required_format: ARTIFACT_REFERENCE_FORMAT, reason });
        assert.match(error.message, /coverage evidence\[1\]/); return true;
      });
      assert.deepEqual(store.events(task.executionId), before);
      assert.equal(store.getExecution(task.scopeId, task.taskId, task.executionId)?.revision, task.revision);
      assert.equal(store.getExecution(task.scopeId, task.taskId, task.executionId)?.reviewStatus, "pending");
    }
    assert.throws(() => store.recordReview(task.scopeId, task.taskId, task.revision - 1, "stale-review-12345678",
      { ...review, criteria: [{ id: "coverage", result: "satisfied", evidence: ["prose"] }] }, task.executionId),
      (error) => error instanceof StoreConflict && error.code === "STALE_REVISION");
    for (const [criteria, reason] of [
      [[{ id: "coverage", result: "satisfied" as const, evidence: [] }], "missing_evidence"],
      [[], "required_criterion_unsatisfied"],
    ] as const) {
      assert.throws(() => store.recordReview(task.scopeId, task.taskId, task.revision, "missing-review-12345678",
        { ...review, criteria: criteria.map(criterion => ({ ...criterion, evidence: [...criterion.evidence] })) }, task.executionId),
      (error) => error instanceof ReviewInputError && error.details.reason === reason && error.details.criterion_id === "coverage");
      assert.deepEqual(store.events(task.executionId), before);
    }
    const accepted = await rpcRequest(root, "record_review", request) as any;
    assert.equal(accepted.reviewStatus, "accepted"); assert.equal(accepted.revision, task.revision + 1);
    const replay = await rpcRequest(root, "record_review", request) as any;
    assert.equal(replay.revision, accepted.revision);
    assert.throws(() => store.recordReview(task.scopeId, task.taskId, accepted.revision,
      request.idempotency_key, { ...review, rationale: "Different" }, task.executionId),
      (error) => error instanceof StoreConflict && error.code === "IDEMPOTENCY_CONFLICT");
    // Non-accepted reviews retain narrative evidence support.
    const correction = store.recordReview(task.scopeId, task.taskId, accepted.revision, "review-correction-123456",
      { ...review, disposition: "needs_correction", criteria: [{ id: "coverage", result: "unsatisfied", evidence: ["Need originals"] }] },
      task.executionId);
    assert.equal(correction.reviewStatus, "needs_correction");
  } finally { await server.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("accepted evidence contract is exported without restricting narrative correction evidence", () => {
  const schema = JSON.stringify(z.toJSONSchema(ReviewSchema));
  assert.match(schema, /For accepted reviews, every entry must be only artifact:/);
  assert.match(schema, /Non-accepted reviews may use narrative evidence/);
  const error = new ReviewInputError({ criterion_id: "coverage", reason: "missing_evidence" });
  assert.equal(error.code, "INVALID_INPUT"); assert.equal(error.retry, "change_input");
});
