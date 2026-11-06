import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactStore, type ArtifactRegistration } from "../artifacts.js";
import { ReviewSchema, type TaskPacket } from "../contracts.js";
import { ProgressManager } from "../progress.js";
import { prepareReview, ReviewPreparationError, type PrepareReviewPage, type ReviewPreparationItem } from "../review-preparation.js";
import { SqliteTaskStore, StoreConflict } from "../store.js";

function fixture(criteria = 2, requirement = "Inspect the original source") {
  const root = mkdtempSync(join(tmpdir(), "pi-review-preparation-"));
  const store = new SqliteTaskStore(join(root, "state.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const progress = new ProgressManager();
  const packet: TaskPacket = { title: "Audit", objective: "Inspect a bounded fixture", tier: "standard",
    authoritative_inputs: [], context: { verified_facts: [], rejected_assumptions: [], exclusions: [] },
    allowed_writes: [], acceptance_criteria: Array.from({ length: criteria }, (_, index) => ({ id: `criterion-${index}`,
      requirement, evidence_required: "Captured source citations", required: true })),
    checks: [], constraints: [], stop_conditions: [], shared_resources: [] };
  let task = store.start({ scopeId: "scope", idempotencyKey: "prepare-review-start-0001", workspace: root,
    packet, profile: "bounded-inspect", model: "fake/model", baselineHash: "a".repeat(64), promptHash: "b".repeat(64) });
  progress.register(task.executionId, "supported");
  const capture = (value: unknown, mediaType = "application/json") => artifacts.captureBytes(task.executionId,
    Buffer.from(typeof value === "string" ? value : JSON.stringify(value)), mediaType, (entry) => store.registerArtifact(entry));
  const report = capture({ schema_version: 2, task_id: task.taskId, execution_id: task.executionId,
    outcome: "completed", summary: "REPORT_BODY_SHOULD_NOT_APPEAR", coverage: [], gaps: [], findings: [],
    changes: [], checks: [], blockers: [], next_action: "Parent review" });
  const summary = capture("SUMMARY_BODY_SHOULD_NOT_APPEAR", "text/markdown");
  let manifest: ArtifactRegistration | null = null;
  const finish = (options: { legacy?: boolean; extra?: Record<string, unknown>; invalidBytes?: string; foreignRole?: boolean } = {}) => {
    const metadata = [report, summary].map((entry, index) => ({ artifact_id: entry.artifactId, sha256: entry.sha256,
      byte_length: entry.byteLength, media_type: entry.mediaType,
      ...(!options.legacy ? { roles: [index === 0 ? "report" : "summary"] } : {}) }));
    if (options.foreignRole) metadata[0]!.artifact_id = "artifact_other_execution";
    manifest = capture(options.invalidBytes ?? { task_id: task.taskId, execution_id: task.executionId,
      starting_state_sha256: task.baselineHash, artifacts: metadata, ...options.extra });
    task = store.transition(task.scopeId, task.taskId, task.revision, "finalizing", "current");
    task = store.finalize(task.scopeId, task.taskId, task.revision, "completed", "valid", manifest.sha256);
    return manifest;
  };
  const request = () => ({ scope_id: task.scopeId, task_id: task.taskId, execution_id: task.executionId });
  const read = (options: Record<string, unknown> = {}) => prepareReview({ ...request(), ...options }, store, artifacts, progress);
  return { root, store, artifacts, progress, packet, capture, report, summary, finish, request, read,
    get task() { return task; }, get manifest() { return manifest; },
    cleanup() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("preparation assembles every criterion without accepting claims or changing durable state", () => {
  const fx = fixture(3);
  try {
    fx.finish();
    const before = JSON.stringify({ task: fx.store.getExecution(fx.task.scopeId, fx.task.taskId, fx.task.executionId),
      events: fx.store.events(fx.task.executionId), artifacts: fx.store.artifactsForExecution(fx.task.executionId) });
    const first = fx.read({ limit: 2 });
    assert.equal(first.readiness.ready_for_parent_review, true);
    assert.equal(first.readiness.parent_verification_required, true);
    assert.equal(first.worker_checkpoint_observed, false);
    assert.equal(first.roles_available, true);
    assert.equal(first.review_template?.disposition, "awaiting_evidence");
    assert.deepEqual(first.review_template?.criteria, []);
    assert.equal(ReviewSchema.safeParse(first.review_template).success, true);
    assert.equal(first.lifecycle_cursor, fx.store.eventCursor(fx.task.executionId));
    const items: ReviewPreparationItem[] = [...first.items];
    let page: PrepareReviewPage = first;
    while (page.next_cursor) {
      page = fx.read({ limit: 2, after_cursor: page.next_cursor });
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 32768);
      items.push(...page.items);
    }
    assert.equal(page.has_more, false);
    assert.equal(items.length, first.totals.criteria! + first.totals.artifacts);
    const criteria = items.filter((item) => item.kind === "criterion");
    assert.deepEqual(criteria.map((item) => item.criterion.id), fx.packet.acceptance_criteria.map((criterion) => criterion.id));
    assert.ok(criteria.every((item) => item.criterion.result === "not_checked" && item.criterion.evidence.length === 0));
    const refs = items.filter((item) => item.kind === "artifact");
    assert.equal(refs.find((item) => item.artifact_id === fx.report.artifactId)?.roles[0], "report");
    assert.equal(refs.find((item) => item.artifact_id === fx.manifest!.artifactId)?.roles[0], "manifest");
    for (const item of refs) {
      assert.equal(item.reference, `artifact:${item.artifact_id}@sha256:${item.sha256}`);
      assert.equal(item.read_artifact.execution_id, fx.task.executionId);
    }
    assert.ok(!JSON.stringify(items).includes("REPORT_BODY_SHOULD_NOT_APPEAR"));
    assert.ok(!JSON.stringify(items).includes("SUMMARY_BODY_SHOULD_NOT_APPEAR"));
    assert.equal(JSON.stringify({ task: fx.store.getExecution(fx.task.scopeId, fx.task.taskId, fx.task.executionId),
      events: fx.store.events(fx.task.executionId), artifacts: fx.store.artifactsForExecution(fx.task.executionId) }), before);
    const assembled = { ...first.review_template!, criteria: criteria.map(({ criterion }) => ({ id: criterion.id,
      result: criterion.result, evidence: criterion.evidence })) };
    assert.equal(ReviewSchema.safeParse(assembled).success, true);
  } finally { fx.cleanup(); }
});

test("byte and count pagination preserves full declarations and advances only through returned items", () => {
  const fx = fixture(25, "Requirement ".repeat(200));
  try {
    fx.finish();
    const items: ReviewPreparationItem[] = [];
    let cursor: string | undefined;
    do {
      const page = fx.read({ max_bytes: 8192, limit: 20, ...(cursor ? { after_cursor: cursor } : {}) });
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 8192);
      assert.ok(page.items.length > 0 && page.items.length <= 20);
      items.push(...page.items);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    const criteria = items.filter((item) => item.kind === "criterion");
    assert.equal(criteria.length, 25);
    assert.equal(new Set(criteria.map((item) => item.index)).size, 25);
    assert.ok(criteria.every((item) => item.criterion.requirement === fx.packet.acceptance_criteria[0]!.requirement));
  } finally { fx.cleanup(); }
});

test("a large individual criterion requests a sufficient larger budget without truncation", () => {
  const fx = fixture(1, "x".repeat(100000));
  try {
    fx.finish();
    let required = 0;
    assert.throws(() => fx.read({ max_bytes: 8192, limit: 1 }), (error) => {
      assert.ok(error instanceof ReviewPreparationError);
      assert.equal(error.code, "INVALID_INPUT"); assert.equal(error.retry, "change_input");
      required = error.details!.required_min_bytes as number;
      assert.ok(required > 8192 && required <= 262144);
      return true;
    });
    const page = fx.read({ max_bytes: required, limit: 1 });
    assert.equal(page.items.length, 1);
    const item = page.items[0]!;
    assert.equal(item.kind, "criterion");
    if (item.kind === "criterion") assert.equal(item.criterion.requirement, "x".repeat(100000));
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= required);
  } finally { fx.cleanup(); }
});

test("unpreparable legacy metadata explains the maximum budget rather than requesting impossible growth", () => {
  const fx = fixture(1, "x".repeat(270000));
  try {
    fx.finish();
    assert.throws(() => fx.read({ max_bytes: 262144 }), (error) => {
      assert.ok(error instanceof ReviewPreparationError);
      assert.equal(error.code, "INVALID_INPUT");
      assert.match(error.message, /unavailable.*maximum 262144/);
      assert.ok((error.details!.required_min_bytes as number) > 262144);
      return true;
    });
  } finally { fx.cleanup(); }
});

test("cursors reject malformed/foreign/stale inputs and detect artifact changes at the same revision", () => {
  const fx = fixture(); const other = fixture();
  try {
    fx.finish(); other.finish();
    const first = fx.read({ limit: 1 });
    assert.ok(first.next_cursor);
    assert.throws(() => fx.read({ after_cursor: "%%%%" }), { code: "INVALID_INPUT", retry: "change_input" });
    assert.throws(() => other.read({ after_cursor: first.next_cursor }), { code: "INVALID_INPUT", retry: "change_input" });
    const revision = fx.store.getExecution(fx.task.scopeId, fx.task.taskId, fx.task.executionId)!.revision;
    fx.capture("additional captured bytes", "text/plain");
    assert.equal(fx.store.getExecution(fx.task.scopeId, fx.task.taskId, fx.task.executionId)!.revision, revision);
    assert.throws(() => fx.read({ after_cursor: first.next_cursor }), { code: "STALE_PREPARATION", retry: "observe_first" });
    const refreshed = fx.read({ limit: 1 });
    fx.store.recordReview(fx.task.scopeId, fx.task.taskId, revision, "prepare-review-state-change-0001", refreshed.review_template!, fx.task.executionId);
    assert.throws(() => fx.read({ after_cursor: refreshed.next_cursor }), { code: "STALE_PREPARATION", retry: "observe_first" });
    assert.throws(() => fx.store.recordReview(fx.task.scopeId, fx.task.taskId, refreshed.expected_revision,
      "prepare-review-stale-submit-0001", refreshed.review_template!, fx.task.executionId),
    (error) => error instanceof StoreConflict && error.code === "STALE_REVISION");
  } finally { fx.cleanup(); other.cleanup(); }
});

test("historical preparation stays bound to the predecessor after continuation", () => {
  const fx = fixture();
  try {
    fx.finish();
    const predecessor = fx.read({ limit: 1 });
    const next = fx.store.continueTask({ scopeId: fx.task.scopeId, taskId: fx.task.taskId,
      predecessorExecutionId: fx.task.executionId, expectedRevision: fx.task.revision,
      idempotencyKey: "prepare-review-follow-up-0001", contextMode: "fresh", packet: fx.packet,
      baselineHash: "c".repeat(64), promptHash: "d".repeat(64), frozenPrompt: "Follow up" });
    const historical = fx.read({ after_cursor: predecessor.next_cursor });
    assert.equal(historical.execution_id, predecessor.execution_id);
    assert.equal(historical.starting_state_sha256, "a".repeat(64));
    const current = prepareReview({ scope_id: next.scopeId, task_id: next.taskId, execution_id: next.executionId }, fx.store, fx.artifacts, fx.progress);
    assert.equal(current.execution_id, next.executionId);
    assert.equal(current.starting_state_sha256, "c".repeat(64));
    assert.equal(current.review_template, null);
    assert.equal(current.totals.artifacts, 0);
    assert.throws(() => prepareReview({ scope_id: next.scopeId, task_id: next.taskId, execution_id: next.executionId,
      after_cursor: predecessor.next_cursor }, fx.store, fx.artifacts, fx.progress), { code: "INVALID_INPUT" });
  } finally { fx.cleanup(); }
});

test("missing evidence returns explicit unreadiness and no invented review hashes", () => {
  const fx = fixture();
  try {
    const page = fx.read();
    assert.equal(page.review_template, null);
    assert.equal(page.final_manifest_sha256, null);
    assert.equal(page.readiness.ready_for_parent_review, false);
    assert.ok(page.readiness.reasons.includes("final_manifest_missing"));
    assert.ok(page.readiness.reasons.includes("execution_not_completed"));
    assert.ok(page.items.filter((item) => item.kind === "artifact").every((item) => item.roles.length === 0));
  } finally { fx.cleanup(); }
});

test("legacy manifests expose citations but do not infer report roles from media types", () => {
  const fx = fixture();
  try {
    fx.finish({ legacy: true });
    const page = fx.read();
    assert.equal(page.roles_available, false);
    assert.ok(page.review_template);
    const item = page.items.find((item) => item.kind === "artifact" && item.artifact_id === fx.report.artifactId)!;
    assert.equal(item.kind, "artifact");
    if (item.kind === "artifact") assert.deepEqual(item.roles, []);
  } finally { fx.cleanup(); }
});

test("complete verified manifests larger than a public artifact page can provide roles without body duplication", () => {
  const fx = fixture();
  try {
    const manifest = fx.finish({ extra: { annotation: "BODY_NOT_FOR_PREPARATION".repeat(4000) } });
    assert.ok(manifest.byteLength > 65536);
    const page = fx.read();
    assert.equal(page.roles_available, true);
    assert.ok(!JSON.stringify(page).includes("BODY_NOT_FOR_PREPARATION"));
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 32768);
  } finally { fx.cleanup(); }
});

test("invalid/foreign-reference manifests are unreadiness, and tampered bytes are actionable integrity errors", () => {
  for (const option of [{ invalidBytes: "not JSON" }, { foreignRole: true }, { extra: { execution_id: "exec_other" } }]) {
    const fx = fixture();
    try {
      fx.finish(option);
      const page = fx.read();
      assert.equal(page.readiness.ready_for_parent_review, false);
      assert.equal(page.roles_available, false);
      assert.equal(page.review_template, null);
      assert.ok(page.items.some((item) => item.kind === "artifact"));
    } finally { fx.cleanup(); }
  }
  const fx = fixture();
  try {
    const manifest = fx.finish();
    writeFileSync(manifest.path, "tampered bytes");
    assert.throws(() => fx.read(), { code: "ARTIFACT_CHANGED", retry: "observe_first" });
    assert.equal(fx.store.getExecution(fx.task.scopeId, fx.task.taskId, fx.task.executionId)!.revision, fx.task.revision);
  } finally { fx.cleanup(); }
});
