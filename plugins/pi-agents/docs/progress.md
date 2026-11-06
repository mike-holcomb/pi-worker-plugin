# Worker progress

The bundled `report_progress` tool publishes bounded worker-authored checkpoints in both profiles without project writes. `pi_get_progress` reads one exact execution and uses an independent opaque cursor. Retain `next_cursor` for unseen deltas; snapshots are opt-in.

Checkpoints are advisory and held in bounded memory. Restart, disconnect, or eviction can produce explicit gaps. They never change task lifecycle, permission requests, report validity, or parent acceptance. Pi transcript text, streamed model output, and tool logs are not exported as progress.

The worker event buffer holds 256 notifications. The supervisor validates checkpoint shape, execution attribution, artifact references, and blocker request IDs. It enforces a 4096-byte checkpoint limit and existing per-execution/aggregate progress bounds. Health and progress reads do not start model inference.

See [tool reference](../skills/pi-agents/references/tools.md) for cursor and wait behavior.
