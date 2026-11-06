import { createHash } from "node:crypto";
import { z } from "zod";
import type { ArtifactRegistration, ArtifactStore } from "./artifacts.js";
import { TaskPacketSchema, type AcceptanceCriterion, type Review } from "./contracts.js";
import type { ProgressManager } from "./progress.js";
import type { SqliteTaskStore, StoredTask } from "./store.js";

const Id = z.string().min(1);
const Digest = z.string().regex(/^[0-9a-f]{64}$/);
export const PrepareReviewSchema = z.object({
  scope_id: Id, task_id: Id, execution_id: Id,
  after_cursor: z.string().min(1).max(512).optional(),
  max_bytes: z.number().int().min(8192).max(262144).default(32768),
  limit: z.number().int().min(1).max(20).default(10),
}).strict();
const CursorSchema = z.object({ v: z.literal(1), e: Id.max(128), r: z.number().int().positive(),
  d: Digest, o: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
type PreparationCursor = z.infer<typeof CursorSchema>;
const EvidenceRoleSchema = z.enum(["report", "summary", "tracked_diff", "staged_diff", "changed_file"]);
export type EvidenceRole = z.infer<typeof EvidenceRoleSchema>;
export type PreparationArtifactRole = EvidenceRole | "manifest";

export class ReviewPreparationError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "STALE_PREPARATION" | "ARTIFACT_CHANGED", message: string,
    readonly retry: "change_input" | "observe_first", readonly details?: Record<string, unknown>) { super(message); }
}

export type ReviewPreparationItem = {
  kind: "criterion"; index: number; criterion: AcceptanceCriterion & { result: "not_checked"; evidence: string[] };
} | {
  kind: "artifact"; index: number; artifact_id: string; sha256: string; byte_length: number; media_type: string;
  roles: PreparationArtifactRole[]; reference: string;
  read_artifact: { scope_id: string; task_id: string; execution_id: string; artifact_id: string };
};
export type PrepareReviewPage = {
  scope_id: string; task_id: string; execution_id: string; expected_revision: number;
  phase: StoredTask["phase"]; observation: StoredTask["observation"]; terminal: boolean; operationally_resolved: boolean;
  report_validity: StoredTask["reportValidity"]; review_status: StoredTask["reviewStatus"];
  starting_state_sha256: string; final_manifest_sha256: string | null;
  lifecycle_cursor: number; progress_cursor: string; progress_available: string; worker_checkpoint_observed: boolean;
  readiness: { ready_for_parent_review: boolean; reasons: string[]; parent_verification_required: true };
  roles_available: boolean; review_template: Review | null;
  totals: { criteria: number | null; artifacts: number };
  page_offsets: { criteria: number; artifacts: number };
  items: ReviewPreparationItem[]; next_cursor: string | null; has_more: boolean;
};

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const terminalPhases = new Set(["completed", "failed", "cancelled", "timed_out"]);

function budgetError(required: number, subject: string): ReviewPreparationError {
  return new ReviewPreparationError("INVALID_INPUT", required > 262144
    ? `review preparation is unavailable: ${subject} exceeds the maximum 262144-byte response budget`
    : `${subject} exceeds max_bytes; increase the budget without truncating evidence or criteria`, "change_input",
  { required_min_bytes: required, maximum_max_bytes: 262144 });
}

function encodeCursor(cursor: PreparationCursor): string {
  const encoded = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  if (encoded.length > 512) throw new ReviewPreparationError("INVALID_INPUT", "execution identity is too large for review preparation", "change_input");
  return encoded;
}

function decodeCursor(encoded: string): PreparationCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded) || Buffer.from(encoded, "base64url").toString("base64url") !== encoded)
      throw new Error("invalid encoding");
    return CursorSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
  } catch { throw new ReviewPreparationError("INVALID_INPUT", "malformed review preparation cursor; start a new preparation read", "change_input"); }
}

function manifestRoles(task: StoredTask, entries: ArtifactRegistration[], artifacts: ArtifactStore): {
  roles: Map<string, PreparationArtifactRole[]>; available: boolean; validManifest: boolean; reasons: string[];
} {
  const roles = new Map<string, PreparationArtifactRole[]>();
  if (!task.finalManifestHash) return { roles, available: false, validManifest: false, reasons: ["final_manifest_missing"] };
  if (!Digest.safeParse(task.finalManifestHash).success)
    return { roles, available: false, validManifest: false, reasons: ["final_manifest_hash_invalid"] };
  const entry = entries.find((artifact) => artifact.sha256 === task.finalManifestHash && artifact.mediaType === "application/json");
  if (!entry) return { roles, available: false, validManifest: false, reasons: ["final_manifest_registration_missing"] };
  roles.set(entry.artifactId, ["manifest"]);
  let bytes: Uint8Array;
  try { bytes = artifacts.readAllVerified(entry); }
  catch { throw new ReviewPreparationError("ARTIFACT_CHANGED", `final manifest is missing or changed: ${entry.artifactId}`, "observe_first"); }
  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    manifest = parsed as Record<string, unknown>;
  } catch { return { roles, available: false, validManifest: false, reasons: ["final_manifest_invalid"] }; }
  if (manifest.task_id !== task.taskId || manifest.execution_id !== task.executionId || manifest.starting_state_sha256 !== task.baselineHash)
    return { roles, available: false, validManifest: false, reasons: ["final_manifest_identity_or_baseline_mismatch"] };
  if (!Array.isArray(manifest.artifacts)) return { roles, available: false, validManifest: false, reasons: ["final_manifest_artifacts_invalid"] };
  const byId = new Map(entries.map((artifact) => [artifact.artifactId, artifact]));
  const seen = new Set<string>();
  let hasRoles = true;
  const candidateRoles = new Map<string, PreparationArtifactRole[]>(roles);
  for (const raw of manifest.artifacts) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { roles, available: false, validManifest: false, reasons: ["final_manifest_artifacts_invalid"] };
    const metadata = raw as Record<string, unknown>;
    const registered = typeof metadata.artifact_id === "string" ? byId.get(metadata.artifact_id) : undefined;
    if (!registered || seen.has(registered.artifactId) || metadata.sha256 !== registered.sha256 ||
      metadata.byte_length !== registered.byteLength || metadata.media_type !== registered.mediaType)
      return { roles, available: false, validManifest: false, reasons: ["final_manifest_artifact_reference_invalid"] };
    seen.add(registered.artifactId);
    if (metadata.roles === undefined) { hasRoles = false; continue; }
    const parsedRoles = z.array(EvidenceRoleSchema).max(5).safeParse(metadata.roles);
    if (!parsedRoles.success || new Set(parsedRoles.data).size !== parsedRoles.data.length)
      return { roles, available: false, validManifest: false, reasons: ["final_manifest_roles_invalid"] };
    candidateRoles.set(registered.artifactId, parsedRoles.data);
  }
  // Legacy manifests remain readable; never infer report/diff roles from media types.
  return { roles: hasRoles ? candidateRoles : roles, available: hasRoles, validManifest: true, reasons: [] };
}

/** Prepare observed metadata only. Criteria are declarations, never worker satisfaction claims. */
export function prepareReview(params: unknown, store: SqliteTaskStore, artifacts: ArtifactStore, progress: ProgressManager): PrepareReviewPage {
  const parsed = PrepareReviewSchema.safeParse(params);
  if (!parsed.success) throw new ReviewPreparationError("INVALID_INPUT", `invalid review preparation request: ${parsed.error.message}`, "change_input");
  const input = parsed.data;
  const task = store.getExecution(input.scope_id, input.task_id, input.execution_id);
  if (!task) throw new ReviewPreparationError("INVALID_INPUT", "exact task execution not found", "change_input");
  const packet = TaskPacketSchema.safeParse(task.packet);
  const declarations = packet.success ? packet.data.acceptance_criteria : [];
  const declarationIds = new Set(declarations.map((criterion) => criterion.id));
  const criteriaValid = packet.success && declarationIds.size === declarations.length;
  const entries = store.artifactsForExecution(task.executionId);
  const manifest = manifestRoles(task, entries, artifacts);
  const reasons = [...manifest.reasons];
  if (task.phase !== "completed") reasons.push("execution_not_completed");
  if (task.observation !== "current") reasons.push("execution_observation_not_current");
  if (!["bounded-build", "bounded-inspect"].includes(task.profile)) reasons.push("unsupported_execution_profile");
  if (task.reportValidity !== "valid") reasons.push("report_not_valid");
  if (!Digest.safeParse(task.baselineHash).success) reasons.push("starting_state_hash_invalid");
  if (!packet.success) reasons.push("frozen_packet_invalid");
  else if (!criteriaValid) reasons.push("duplicate_criterion_ids");
  const items: ReviewPreparationItem[] = [
    ...declarations.map((criterion, index): ReviewPreparationItem => ({ kind: "criterion", index,
      criterion: { ...criterion, result: "not_checked", evidence: [] } })),
    ...entries.map((entry, index): ReviewPreparationItem => ({ kind: "artifact", index,
      artifact_id: entry.artifactId, sha256: entry.sha256, byte_length: entry.byteLength, media_type: entry.mediaType,
      roles: manifest.roles.get(entry.artifactId) ?? [], reference: `artifact:${entry.artifactId}@sha256:${entry.sha256}`,
      read_artifact: { scope_id: task.scopeId, task_id: task.taskId, execution_id: task.executionId, artifact_id: entry.artifactId } })),
  ];
  const digest = hash({ scope_id: task.scopeId, task_id: task.taskId, execution_id: task.executionId,
    packet_valid: packet.success, criteria_valid: criteriaValid, starting_state_sha256: task.baselineHash,
    final_manifest_sha256: task.finalManifestHash, items });
  const cursor = input.after_cursor ? decodeCursor(input.after_cursor) : null;
  if (cursor && cursor.e !== task.executionId) throw new ReviewPreparationError("INVALID_INPUT", "review preparation cursor belongs to another execution", "change_input");
  if (cursor && (cursor.r !== task.revision || cursor.d !== digest)) throw new ReviewPreparationError("STALE_PREPARATION", "review preparation changed; restart from the first page and inspect the current execution", "observe_first");
  const offset = cursor?.o ?? 0;
  if (offset > items.length) throw new ReviewPreparationError("INVALID_INPUT", "review preparation cursor is beyond the collection", "change_input");
  const terminal = terminalPhases.has(task.phase);
  const hasHashes = Digest.safeParse(task.baselineHash).success && Digest.safeParse(task.finalManifestHash).success;
  const reviewTemplate: Review | null = hasHashes && criteriaValid && manifest.validManifest ? {
    disposition: "awaiting_evidence", rationale: "Parent verification required; inspect the cited artifacts and every declared criterion.",
    criteria: [], starting_state_sha256: task.baselineHash, final_manifest_sha256: task.finalManifestHash!,
    freshness: "Parent freshness verification required.", integration_checks: [], coverage_limits: [], unresolved_issues: [],
    next_action: "Collect every preparation page, assemble all criteria, inspect full evidence, and record the parent decision.",
  } : null;
  const hint = progress.hint(task.executionId);
  const page: PrepareReviewPage = {
    scope_id: task.scopeId, task_id: task.taskId, execution_id: task.executionId, expected_revision: task.revision,
    phase: task.phase, observation: task.observation, terminal, operationally_resolved: terminal,
    report_validity: task.reportValidity, review_status: task.reviewStatus,
    starting_state_sha256: task.baselineHash, final_manifest_sha256: task.finalManifestHash,
    lifecycle_cursor: store.eventCursor(task.executionId), ...hint,
    readiness: { ready_for_parent_review: reasons.length === 0, reasons, parent_verification_required: true },
    roles_available: manifest.available, review_template: reviewTemplate,
    totals: { criteria: packet.success ? declarations.length : null, artifacts: entries.length },
    page_offsets: { criteria: Math.min(offset, declarations.length), artifacts: Math.max(0, offset - declarations.length) },
    items: [], next_cursor: null, has_more: offset < items.length,
  };
  const nextCursor = (next: number) => next < items.length ? encodeCursor({ v: 1, e: task.executionId, r: task.revision, d: digest, o: next }) : null;
  page.next_cursor = nextCursor(offset);
  if (size(page) > input.max_bytes) throw budgetError(size(page), "review preparation metadata");
  for (const item of items.slice(offset, offset + input.limit)) {
    const trial = { ...page, items: [...page.items, item], next_cursor: nextCursor(offset + page.items.length + 1),
      has_more: offset + page.items.length + 1 < items.length };
    if (size(trial) > input.max_bytes) {
      if (page.items.length === 0) throw budgetError(size(trial), "next review preparation item");
      break;
    }
    page.items = trial.items; page.next_cursor = trial.next_cursor; page.has_more = trial.has_more;
  }
  return page;
}
