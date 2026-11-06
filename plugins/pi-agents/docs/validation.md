# Validation

The Pi fork has its own automated checks. Historical OpenCode results are not Pi evidence.

Runtime tests cover durable admission, idempotency, queue/resource reservations, evidence capture, immutable artifact reads, review gates, pagination, progress, transport recovery, cancellation, and schema migration backups. Pi tests add real SQLite reopen, durable permissions, exact submission/result recovery, filesystem bounds, pinned native provider catalogs, and owned worker processes against a local OpenAI-compatible fixture server.

Process integration exercises exclusive worker election, reconnecting to a surviving worker, new-process storage recovery, interrupted shell effects without replay, fresh approval, and supervisor report/continuation workflows.

Packaging checks verify archive determinism, the allowlist, source-to-executable correspondence, per-file manifests, checksums, third-party licenses, and relocation into a read-only directory containing spaces. The fixture evaluation harness validates twelve inherited scenarios and two paired documentation-audit scenarios without model inference.

Automated fixture execution does not establish hosted-provider quality or billing. Live native-provider credentials, marketplace installation in a fresh client, Linux live process behavior, hostile concurrent filesystem modification, and machine power-loss durability require separate evidence. SQLite WAL uses Pi's upstream durability semantics. Arbitrary approved shell commands run as the host user and may escape tool-level path restrictions.

Issues 7–10 add deterministic coverage for concurrent and retained native request ID reuse, execution-isolated replies across coordinator restart, all migrated request states, original reply hashes, backup/migration failure, worker-visible denial context, stale bindings, unsupported backends, lost acknowledgements, cancellation, shell readiness, and private-directory/Unix IPC restrictions. The approval evaluation performs three file effects plus one check versus one combined file effect plus one check; both also save a schema-valid report without a permission request. Timing is synthetic parent delay and execution time, not measured live-model performance.

The development-only tsx evaluation uses a frozen synthetic TypeScript assertion, minimal PATH and an explicitly selected supported Node, plus clean and shared-symlink dependency layouts. It preserves each original result independently and leaves file-tool symlink restrictions intact. These experiments diagnose facility differences; they do not establish the cause of the original issue 8 session or justify a production temp override. No live-model steering/compliance or reusable-grant result is claimed.
