# Pi Worker Plugin marketplace

Public repository marketplace for [Pi Agents](plugins/pi-agents/README.md), published by Mike Holcomb under the [MIT License](LICENSE). Delegate bounded work to local workers powered by [Earendil Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable), then inspect evidence and record your review.

## Release 0.2.0 candidate

Version **0.2.0** is being prepared. It adds actionable review validation, compact artifact reads, clearer audit contracts and checkpoint diagnostics, and a read-only review-preparation tool. See the [candidate release notes](docs/releases/v0.2.0.md). The published stable release is [v0.1.0](https://github.com/mike-holcomb/pi-worker-plugin/releases/tag/v0.1.0).

For the published stable release, install Node.js 24.15 or later within the 24.x line and select the plugin from the marketplace:

```bash
codex plugin marketplace add mike-holcomb/pi-worker-plugin --ref v0.1.0
codex plugin add pi-agents@pi-worker-plugin
```

To try the 0.2.0 candidate from this checkout, use the [local installation guide](plugins/pi-agents/docs/installation.md). Start a fresh Codex session and select `pi-agents:pi-agents` (**Pi Agents**). The executable includes Pi Durable 1.5.0 and its provider dependencies; no Pi CLI, backend server, Python, or runtime `npm install` is required.

## Execution setup

Follow the [installation and configuration guide](plugins/pi-agents/docs/installation.md) to declare project roots and model routes. Supported routes include OpenAI, Anthropic, Google, OpenRouter, and custom OpenAI-compatible endpoints. Hosted providers use credentials from the host environment; a loopback endpoint can run without a provider key. Installation and diagnostics do not run inference.

The parent approves scoped worker effects and reviews immutable evidence before accepting a result. Approved shell commands run as the host user. See [validation](plugins/pi-agents/docs/validation.md) for measured coverage and remaining checks, and [progress](plugins/pi-agents/docs/progress.md) for incremental checkpoints.

## Distribution and development

Candidate release assets will be `pi-agents-v0.2.0.zip`, a per-file `.manifest.json`, and a `.sha256` sidecar. The [release process](docs/release-process.md) describes validation, draft preparation, and publication. This repository marketplace is separate from OpenAI's public plugin directory.

The catalog is [.agents/plugins/marketplace.json](.agents/plugins/marketplace.json), and the canonical plugin source is [plugins/pi-agents](plugins/pi-agents). See its [build instructions](plugins/pi-agents/README.md#build-and-verify) and [evaluation guide](plugins/pi-agents/docs/evaluation.md).

This independent fork derives from OpenCode Worker Plugin 2.1.0 (commit `aa5a2df14b8c8f6e2396b7dfd4d7c3b00f50be1d`). Separate names, configuration, and state allow both plugins to be installed together. Historical OpenCode results do not certify Pi execution.
