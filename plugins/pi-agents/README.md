# Pi Agents

Delegate bounded work through a local supervisor and owned Pi Durable worker processes. The parent supplies the task packet, inspects immutable evidence, and records acceptance. Worker completion leaves review pending.

## Install and configure

Use Node `>=24.15 <25` on macOS or Linux. Pi Durable 1.5.0 and provider SDKs ship in the executable; startup needs no `npm install` or Pi CLI. See [installation](docs/installation.md) for local marketplace installation, model routes, credentials, and state locations.

The `pi-agents:pi-agents` skill uses eleven `pi_*` MCP tools. [Tool reference](skills/pi-agents/references/tools.md), [progress](docs/progress.md), and [validation](docs/validation.md) describe the contracts and measured limits.

## Build and verify

```bash
cd runtime
npm ci --ignore-scripts
npm run check
npm run bundle
npm test
cd ..
node scripts/build_bundle.mjs --check
node --test tests/packaging.test.mjs
node --test evaluation/harness.test.mjs
node evaluation/harness.mjs validate
node scripts/build_bundle.mjs --out /tmp/pi-agents-v0.1.0.zip
node scripts/smoke_installed_bundle.mjs /tmp/pi-agents-v0.1.0.zip
```

Use a new archive output path for each build. The allowlisted archive is deterministic and ships per-file hashes, archive checksums, and third-party licenses. State, reports, configuration, and credentials live outside the installed bundle.

Publisher: Mike Holcomb. License: [MIT](LICENSE). Derived from OpenCode Worker Plugin 2.1.0; its historical validation does not certify Pi execution.
