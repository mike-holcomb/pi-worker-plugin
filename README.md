# Pi Worker Plugin

A Codex marketplace plugin for bounded workers powered by [Earendil Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable).

Version **0.1.0** preserves durable task admission, recovery, progress, permissions, immutable evidence, and parent review from OpenCode Worker Plugin 2.1.0 (commit `aa5a2df14b8c8f6e2396b7dfd4d7c3b00f50be1d`). Workers use the bundled Pi Durable 1.5.0 library; no worker CLI or backend server installation is required.

See [Pi Agents](plugins/pi-agents/README.md) and the [installation guide](plugins/pi-agents/docs/installation.md). The marketplace is `.agents/plugins/marketplace.json`.

This repository is an independent MIT-licensed fork. It uses separate names, configuration, and state so both plugins can be installed together. No release tag or GitHub publication is implied by the local build.
