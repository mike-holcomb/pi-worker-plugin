# Prepare an exact-execution parent review

Use `pi_prepare_review` with the retained `scope_id`, `task_id`, and **required** `execution_id`. It returns observed execution state, `expected_revision`, starting/final hashes, separately named lifecycle and progress cursors, declared criteria, and artifact citations. This read invokes no inference or backend inspection and changes no task, evidence, or review state.

The response contains a `review_template` and paginated `items`. Criterion items combine the declared requirement, required evidence, and required flag with `result: "not_checked"` and an empty evidence array. Artifact items provide exact-execution `pi_read_artifact` arguments and a ready-to-copy `artifact:<artifact_id>@sha256:<hash>` reference. The template's empty `criteria` array is an assembly placeholder, **not** proof that the task has no criteria.

Start without `after_cursor`, retain the response identity and revision, and follow every `next_cursor` until null. Collect all criterion items and artifact items in order. Compare the collected counts with `totals`, reject duplicate indices, and assemble `review_template.criteria` from each criterion item's `id`, `result`, and `evidence` only. Requirement descriptions and required flags explain the contract and do not belong in submitted review criteria. Preserve all returned execution IDs and hashes together.

Pages default to ten items and a 32768-byte structured-response budget. `limit` may be 1–20; `max_bytes` may be 8192–262144. The full structured envelope stays within that budget; MCP framing adds overhead. A complete criterion is never truncated. If the next item cannot fit, an `INVALID_INPUT` error with `change_input` supplies `required_min_bytes`; retry the same cursor with a sufficient larger budget. Metadata above the maximum budget cannot be prepared through this endpoint. Do not advance a cursor after an error.

The cursor is opaque and bound to the execution, revision, and evidence/criteria collection. Keep it separate from lifecycle and progress cursors. `STALE_PREPARATION` with `observe_first` means the snapshot changed: discard the assembled pages and restart preparation for that exact execution. Additional artifact registration can invalidate preparation even if the execution revision did not change. Preparation does not reserve a revision or freeze the live workspace.

For normal completion, collect every page, read the entire cited report, summary, manifest, diff, and relevant file evidence, verify each required criterion and current workspace freshness, then replace the template placeholders with the parent's conclusions. Mark a criterion satisfied only after inspecting its evidence. Copy citation-only strings into accepted-review evidence; explanatory prose belongs in review-level rationale, freshness, or integration checks. Choose the disposition and a new mutation idempotency key yourself. A review-ready state, valid report, artifact role, or worker checkpoint is not parent acceptance.

After a continuation, prepare either the retained predecessor execution or the new execution explicitly. A predecessor cursor cannot be used on the successor. Evidence, baselines, and review decisions remain execution-specific. If submission returns `STALE_REVISION`, reread that execution and refresh the preparation and verification before submitting an updated review; never silently substitute the current execution.

Missing final hashes or an invalid/missing manifest produce unreadiness reasons and a null `review_template`, alongside available evidence references. Continue normal supervision or inspect the missing evidence; do not invent hashes or infer completion. Missing or changed registered manifest bytes produce `ARTIFACT_CHANGED` with `observe_first`.

New manifests record explicit artifact roles. One artifact can have several roles when byte-identical evidence is deduplicated, such as empty worktree and staged diffs. The manifest itself receives the `manifest` role from its execution-bound hash. Legacy manifests without role metadata return `roles_available: false`; other roles remain empty rather than being guessed from media types. Roles aid navigation and do not replace inspection. Full report summaries, coverage gaps, and artifact bodies remain in the cited artifacts and are not duplicated in preparation pages.

## Assemble a complete template

For an MCP client, `client.callTool` returns each page in `structuredContent`. This parent-side example collects the complete template; it deliberately leaves all criteria unchecked:

```javascript
const identity = { scope_id: retainedScope, task_id: retainedTask, execution_id: retainedExecution };
let after_cursor;
let first;
const criteria = new Map();
const artifacts = new Map();
do {
  const response = await client.callTool({ name: "pi_prepare_review", arguments: {
    ...identity, ...(after_cursor ? { after_cursor } : {})
  } });
  if (response.isError) throw new Error("Inspect the preparation error before retrying.");
  const page = response.structuredContent;
  first ??= page;
  if (page.scope_id !== identity.scope_id || page.task_id !== identity.task_id ||
      page.execution_id !== identity.execution_id || page.expected_revision !== first.expected_revision)
    throw new Error("Discard pages and restart exact-execution preparation.");
  for (const item of page.items) {
    const collection = item.kind === "criterion" ? criteria : artifacts;
    if (collection.has(item.index)) throw new Error("Duplicate preparation item.");
    collection.set(item.index, item);
  }
  after_cursor = page.next_cursor;
} while (after_cursor);
if (criteria.size !== first.totals.criteria || artifacts.size !== first.totals.artifacts)
  throw new Error("Incomplete preparation collection.");
if (!first.review_template) throw new Error("Inspect readiness reasons and missing evidence.");
const review = { ...first.review_template, criteria: [...criteria.values()].map(({ criterion }) => ({
  id: criterion.id, result: criterion.result, evidence: [...criterion.evidence]
})) };
// Inspect every artifact and required criterion, then supply parent conclusions
// and current freshness before calling pi_record_review with expected_revision.
```

MCP preparation failures return `isError: true` with an `error` object in both `structuredContent` and the JSON text content. Inspect `error.code`, `error.message`, `error.retry`, and optional `error.details`. For a large criterion, retry that same cursor with `max_bytes` set to `error.details.required_min_bytes` within `error.details.maximum_max_bytes`. A stale-preparation error requires restarting the entire collection.
