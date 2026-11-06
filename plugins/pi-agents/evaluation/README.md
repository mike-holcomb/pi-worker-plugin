# V2 evaluation scenarios

This directory holds fourteen small, frozen scenarios for the v2 task interface. The Node harness prepares isolated workspaces and checks observable results. It never starts Pi, an MCP client, or model inference. A parent runs a v2 task separately, inspects its immutable artifacts, and owns the review decision.

`v2-cases.json` contains each task packet, fixture file hashes, and 85 frozen checks. The harness validates every packet against the bundled `schemas/task-packet.schema.json` and verifies the schema and fixture hashes before every command. The file scenarios cover narrow lookup, log investigation, retry bounds, a coupled v2 wire format, contradictory evidence, bounded negative findings, stale evidence, scope growth, dirty state, false completion, context reconciliation, and failed checks. Python files under `fixtures/` are sample project code and local unit tests, not an execution backend for the toolkit.

## Prepare one scenario

Use Node 24.15+ and a new workspace and state path for each run:

```sh
node harness.mjs validate
node harness.mjs list
node harness.mjs prepare --case lookup-timeout --run-id trial-01 \
  --out /private/tmp/v2-eval-trial-01-work \
  --state /private/tmp/v2-eval-trial-01-baseline.json
```

`prepare` refuses to reuse either path. It copies only the named fixture files and a short task description into the worker workspace. It writes the baseline outside that workspace. Its JSON output contains the frozen v2 packet to submit with the workspace path, configured model, limits, scope, and idempotency key through `pi_start_task`. It does not copy the hidden check definitions into the worker workspace. A manifest or packet schema change after preparation makes the check reject the old baseline; start a fresh run instead of rewriting checks after seeing an answer.

The task's authoritative `summary.md` belongs to the execution report directory, not the project workspace. The packet's `allowed_writes` names only project outputs. After the task ends, export its immutable summary artifact to a parent-controlled file outside the worker workspace and retain the artifact SHA-256 from `pi_get_task`. For example, the toolkit CLI can export the exact artifact:

```sh
pi-agents artifacts export SCOPE TASK_ID EXECUTION_ID SUMMARY_ARTIFACT_ID /private/tmp/v2-eval-trial-01-summary.md
node harness.mjs check --case lookup-timeout \
  --workdir /private/tmp/v2-eval-trial-01-work \
  --state /private/tmp/v2-eval-trial-01-baseline.json \
  --result-file /private/tmp/v2-eval-trial-01-summary.md \
  --result-sha256 SUMMARY_ARTIFACT_SHA256
```

The harness rejects an exported result whose bytes do not match the supplied immutable artifact hash. `check` runs the frozen local `python3 -m unittest` commands where specified, with no shell interpolation and a bounded timeout. It checks result text, fixture changes, and write scope; it does not infer an answer. Its exit codes are 0 for all automated checks passing without parent review, 1 for an automated failure, 2 when automated checks pass but parent review is required, and 3 for invalid input or a broken frozen manifest. Every current scenario requires parent review, so exit 2 is the expected automated success state.

Parent review must inspect the report, final manifest, changed files, and source evidence. Text markers only show that a claim was written; they do not prove the claim. Record the review separately through `pi_record_review` when its structural requirements are met. A completed worker turn, passing local command, or `review_required` checker result does not imply acceptance. Keep exact model/destination, revisions, elapsed time, observed usage or `not_captured`, artifacts, and decision for each run.

## Paired documentation audit and progress trial

`audit-sampled` and `audit-complete` use identical eight-file root/plugin/skill fixtures with contradictions distributed across later documents. The sampled packet permits bounded sampling with honest limits. The complete packet requires all eight full reads and every specified metadata comparison. Use a fresh workspace, state path, and run ID for each packet; do not reuse one run's results as the other packet's evidence.

Their automated checks observe a summary, status/source markers, and unchanged project files. Four parent-review dimensions remain separate: truthful limits, original-source grounding, contradiction discovery, and negotiated coverage. A partial summary can legitimately pass automated observations while complete coverage remains unmet. Every finding must be inspected against original files; a status word or filename list is not proof a file was read. Do not accept a complete-coverage criterion with sampled or uninspected required sources. Useful findings and report-schema validity remain distinct from parent acceptance.

For progress trials, retain both cursor types and use exact-execution progress-aware waits as described in [progress guidance](../docs/progress.md). Record native `report_progress` emission, supervisor ingestion, last checkpoint timestamp, and parent-visible pages separately. The inventory/comparison/coverage milestones are qualitative prompts, not timed guarantees. The harness prepares/checks these packets without inference; no live-model reliability result is claimed by fixture validation or deterministic scripted publication tests.

## Shell readiness and approval granularity (development checkout)

After installing locked runtime development dependencies and running `npm run build` in `runtime`, run `npm run evaluate:shell` and `npm run evaluate:approvals` there. These additional evaluations use no live model, network, or user project inputs. They are development checks, separate from the fourteen frozen artifact scenarios and unavailable from an installed bundle without its development source.

The shell evaluation retains four original exit/output records: clean and shared-symlink fixtures each run first with minimal PATH and then with an explicitly selected supported Node against locked tsx. It uses newly allocated private directories, including a short synthetic temp path for the positive IPC comparison; it never changes production TMPDIR. A missing executable is distinct from an actual failed test, inaccessible dependency, temp/IPC failure, or uncertain interruption. File-tool access through the shared symlink remains rejected even when the exact approved shell check can use it.

The approval evaluation drives real durable harness tools with scripted model responses. Three file effects plus one content assertion need four exact replies; one combined write plus the same assertion needs two. The assigned report needs no reply. Output records request counts by effect type, synthetic parent wait time, execution time, actual final file content, observed check success, and schema-valid reporting separately. Neither result is parent acceptance or live-model quality. Durable permissions, reopen, interrupted effects, and denial-context delivery have separate regression coverage.
