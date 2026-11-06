# Worker progress

The bundled `report_progress` tool publishes bounded worker-authored checkpoints in both profiles without project writes. `pi_get_progress` reads one exact execution and uses an independent opaque cursor. Retain `next_cursor` for unseen deltas; snapshots are opt-in.

Checkpoints are advisory and held in bounded memory. Restart, disconnect, or eviction can produce explicit gaps. They never change task lifecycle, permission requests, report validity, or parent acceptance. Pi transcript text, streamed model output, and tool logs are not exported as progress.

The worker event buffer holds 256 notifications. The supervisor validates checkpoint shape, execution attribution, artifact references, and blocker request IDs. It enforces a 4096-byte checkpoint limit and existing per-execution/aggregate progress bounds. Health and progress reads do not start model inference.

See [tool reference](../skills/pi-agents/references/tools.md) for cursor and wait behavior.

## Supported channel versus observed checkpoints

`worker_checkpoint_observed` is a boolean on progress pages and task/wait progress hints. `false` means the supervisor has no retained checkpoint observation for this execution; it does not mean the channel is broken or the worker is stalled. `availability: "supported"` only describes channel capability. After an admitted checkpoint, the boolean is `true` even when an empty delta omits the snapshot. It remains true across a gap that retains the latest snapshot and becomes false after a supervisor restart or full buffer eviction. It is not a durable all-time counter. `runtime.last_worker_checkpoint_at` names the retained observation timestamp; runtime/backend observations remain separate.

## Supervising a quiet audit

1. Retain the exact scope/task/execution IDs, revision, and numeric lifecycle cursor returned by start. Read `pi_get_progress` once and retain its opaque `next_cursor` separately.
2. Continue independent parent work. When an update would help coordination, call `pi_wait_tasks` with the numeric lifecycle `after_cursor`, exact `execution_id`, and opaque `after_progress_cursor`; use a bounded timeout up to 30 seconds.
3. On a progress hint, read unseen checkpoints using `pi_get_progress` with its `after_cursor` set to the retained progress cursor. Consume the page and advance to `next_cursor`. After an explicit gap, advance to its recovery cursor and inspect the retained snapshot when present.
4. A timed-out wait needs no immediate progress poll. Continue parent work or another bounded wait when coordination requires it. Refresh task state for an actionable lifecycle change, request, deadline, or recovery need. Silence, absent checkpoints, and a timeout do not authorize a replacement worker or prove a stall.
5. Review final frozen evidence and coverage independently. A checkpoint is a worker claim, not acceptance or a terminal-state signal.

For checkpoint-emission investigations, use the explicit `audit-complete` evaluation packet and record emission, ingestion, and parent presentation separately. Deterministic scripted-tool tests establish the publication/attribution/wait path; they do not establish that a real model reliably follows milestone guidance. No periodic runtime heartbeat is introduced, and tool logs, filenames, source excerpts, or hidden reasoning are not exported as progress.
