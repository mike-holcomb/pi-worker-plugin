export const ARTIFACT_REFERENCE_FORMAT = "artifact:<artifact_id>@sha256:<64 lowercase hexadecimal characters>";
export const ARTIFACT_REFERENCE_PATTERN = /^artifact:([^@\s]+)@sha256:([0-9a-f]{64})$/;

/** Correctable review input errors, distinct from execution state conflicts. */
export class ReviewInputError extends Error {
  readonly code = "INVALID_INPUT";
  readonly retry = "change_input";
  constructor(readonly details: {
    criterion_id: string;
    reason: "malformed_reference" | "unknown_artifact" | "hash_mismatch" | "duplicate_criterion" |
      "undeclared_criterion" | "missing_evidence" | "required_criterion_unsatisfied";
    evidence_index?: number;
    required_format?: string;
  }) {
    super(`Review criterion ${details.criterion_id}${details.evidence_index === undefined ? "" : ` evidence[${details.evidence_index}]`}: ${details.reason.replaceAll("_", " ")}${details.required_format ? `; expected ${details.required_format}. Put explanatory prose in review rationale, freshness, or integration_checks.` : ""}`);
  }
}
