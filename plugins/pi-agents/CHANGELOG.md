# Changelog

## 0.1.0

- Fork OpenCode Worker Plugin 2.1.0 into independent Pi Agents names and state.
- Replace the worker server/SDK with pinned Pi Durable 1.5.0 and owned local processes.
- Preserve the eleven task/recovery/progress/evidence/review operations and scoped permission replies.
- Add explicit native OpenAI, Anthropic, Google, OpenRouter, and custom OpenAI-compatible model configuration.
- Recover exact submissions and permission waits; never replay interrupted effectful tool calls automatically.
- Bundle the runtime and provider dependencies with deterministic packaging and license notices.
