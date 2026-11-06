# V2 MCP operations

The plugin registers twelve `pi_` tools. Use their exposed input schemas for field spelling. `scope_id` is a durable parent workflow label. Generate a distinct 16–128 character `idempotency_key` for each mutation and reuse the exact key and payload when acknowledgement is lost. Read-only observation never starts inference.

| Tool | Use |
| --- | --- |
| `pi_health` | Check runtime, backend compatibility, queue, and storage without inference; opt into `shell_preflight: true` for bounded daemon shell/temp/IPC diagnostics. |
| `pi_start_task` | Preview with `dry_run: true`, or admit one packet and return durable identities. |
| `pi_get_task` | Read current execution state, pending requests, artifacts, review, and events after a cursor. |
| `pi_get_progress` | Read bounded unseen checkpoints for the required exact execution, using an execution-bound progress cursor. |
| `pi_list_tasks` | Recover task identities in a scope with filters and pagination. |
| `pi_wait_tasks` | Wait up to 30 seconds for a material change; expiration does not stop work. |
| `pi_continue_task` | Create a follow-up execution after a resolved predecessor, with `resume` or `fresh` context. |
| `pi_cancel_task` | Record a stop request; inspect again for confirmed stopping. |
| `pi_respond_to_request` | Reply to an exact current request with its revision and audit basis; permission denials may include `worker_explanation`. |
| `pi_read_artifact` | Read a bounded range of a captured immutable artifact. |
| `pi_prepare_review` | Prepare exact-execution criteria, artifact citations, readiness, and a review template without accepting worker claims. |
| `pi_record_review` | Append the parent's criterion-by-criterion evidence decision. |

Start and continue return after durable acceptance, which may still be queued. Keep the returned IDs, revision, and event cursor. Permission replies are `allow_once` or `deny`; `allow_once` is not a standing permission. Native questions may be unavailable on a backend. Treat `UNSUPPORTED_BACKEND` and `POLICY_MISMATCH` as dispatch gates, not prompts to use the old runner.

For event pagination, repeat `pi_get_task` with `after_cursor` while `has_more_events` is true. An oversized event carries `detailTruncated.cursor`; pass it as `event_detail_cursor` to `pi_get_task` and follow `event_detail.nextDetailCursor` until null. Decode and concatenate the base64 chunks to recover the exact durable detail. The preview is not the full blocker text.

`authorization_basis` is audit-only and never becomes worker-visible task instructions. Optional `worker_explanation` is a separate nonempty string, at most 4,096 UTF-8 bytes, valid only for a permission `deny`. Retain scope/task/execution/request/revision and the exact payload on retry; changing the explanation with the same key is an idempotency conflict. The intent event records the supplied explanation; the acknowledgement event reports `worker_explanation_delivery: "acknowledged"` only after durable worker acceptance. A vanished request with a lost acknowledgement remains unconfirmed and is not resent. None of these states proves model compliance. Cancelled workers take precedence over feedback. General steering is unavailable; scope changes require a new linked task after confirmed stopping.

Native `request_id` is unique only within an execution. Always retain the scope, task, execution, request ID, and request revision together, including when another worker exposes the same number.

The diagnostic executable supports `pi-agents doctor` and the documented daemon, task, and artifact commands when installed. It uses the same durable services as MCP. Keep configuration, reports, state, and credentials outside the installed plugin; `PI_AGENTS_STATE_DIR` selects a private state location. Pi is bundled; configure an explicit authorized provider/model and environment credentials. `pi-agents doctor --shell-preflight` labels results `local_process`; MCP `pi_health` with `shell_preflight: true` labels the daemon's environment. Both use fixed probes, private temporary storage, and bounded statuses without exposing PATH/HOME values or credentials. Readiness is representative and does not prove a particular project check will pass.

Keep each execution's `next_cursor` after consuming a progress page. `after_cursor` is exclusive; unchanged streams return empty deltas. Retrying the same retained cursor deliberately replays its page. Progress cursors are opaque strings, distinct from numeric lifecycle event cursors, and cannot cross executions or continuations. Defaults are five updates/8 KiB, with caps of twenty/32 KiB. The byte budget covers the structured progress response; MCP framing adds transport overhead. Use `include_snapshot` only when needed; a large snapshot plus checkpoint may require a larger byte budget.

Progress is memory-first advisory data. Restart, disconnect, attribution or publication failure, and eviction return an explicit gap and a head recovery cursor, plus the latest snapshot when available. Attribution and publication failures use `attribution_failure` and increment `dropped_count` without reconnecting the event stream or changing the task lifecycle. Advance to the recovery cursor to consume future checkpoints. V1 does not recover checkpoints from message history. `unsupported` or `not_enabled` availability does not block normal execution. Runtime observation and last-checkpoint timestamps are separate; silence is not a stalled verdict.

To wake a wait for checkpoints, supply `execution_id` and `after_progress_cursor` on that target. The wait returns only a progress hint, never checkpoint bodies. Read unseen checkpoints when coordination benefits; avoid tight polling. The read endpoint contains no steering/reply operation and invokes no model or backend inspection.

For review preparation, retain exact identity and collect every bounded page before constructing the review criteria array. Preparation cursors bind the execution, revision, and evidence collection; stale pages must be restarted. See [review preparation](review-preparation.md) for fields, artifact roles, byte budgets, and a complete parent assembly example.

Progress pages and hints expose `worker_checkpoint_observed` independently of `availability`/`progress_available`. It means at least one checkpoint remains observed in the retained supervisor buffer, not that the worker is currently active. An empty delta can still have `true`; restart/full eviction resets observation to `false`. Follow the [quiet-worker supervision pattern](../../../docs/progress.md) and retain both cursor types.
