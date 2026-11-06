# Changelog

## 0.2.0

- Explain accepted-review input errors with criterion/evidence details while preserving evidence and revision gates (#1).
- Document worker profile capabilities and parent ownership of shell-based audit checks (#2).
- Return one lossless artifact representation with explicit encoding and compact MCP framing (#3).
- Distinguish supported progress from observed worker checkpoints and document quiet-worker supervision (#4).
- Add explicit must-inspect audit contracts and paired frozen coverage evaluations (#5).
- Add bounded, exact-execution `pi_prepare_review` with criterion templates, artifact citations, and explicit evidence roles (#6).
- Scope native permission IDs to their execution, migrate durable stores to schema 4 with a pre-upgrade backup, and expose registration failures without releasing ownership (#7).
- Add opt-in bounded shell/Node/private-temp/IPC preflight and offline tsx environment evaluations; separate completed failing checks from uncertain effects (#8).
- Explain exact approval granularity and measure three edits versus a combined edit separately from completion quality; retain `allow_once` without reusable grants (#9).
- Add optional, durable worker-visible permission-denial explanations distinct from audit rationale, with bounded payloads and exact retry/session bindings (#10).
- Keep Pi Durable 1.5.0 and existing permissions; update the packaged runtime to 0.2.0.

## 0.1.0

- Fork OpenCode Worker Plugin 2.1.0 into independent Pi Agents names and state.
- Replace the worker server/SDK with pinned Pi Durable 1.5.0 and owned local processes.
- Preserve the eleven task/recovery/progress/evidence/review operations and scoped permission replies.
- Add explicit native OpenAI, Anthropic, Google, OpenRouter, and custom OpenAI-compatible model configuration.
- Recover exact submissions and permission waits; never replay interrupted effectful tool calls automatically.
- Bundle the runtime and provider dependencies with deterministic packaging and license notices.
