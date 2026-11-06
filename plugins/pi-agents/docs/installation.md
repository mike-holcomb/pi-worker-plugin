# Installation, configuration, and rollback

## Install release 0.1.0

Version 0.1.0 is the published stable release. This checkout prepares 0.2.0; use local installation below to try the candidate. Once 0.2.0 is published, select `--ref v0.2.0` explicitly.

1. Install Node.js `>=24.15 <25` on macOS or Linux and ensure the Codex host's `node` resolves to that version.
2. Add the repository marketplace and install the plugin:

   ```bash
   codex plugin marketplace add mike-holcomb/pi-worker-plugin --ref v0.1.0
   codex plugin add pi-agents@pi-worker-plugin
   ```

3. Start a fresh Codex session and select `pi-agents:pi-agents` (**Pi Agents**).
4. Configure project roots and model routes as described below before submitting live tasks.

The GitHub release includes `pi-agents-v0.1.0.zip`, its per-file `.manifest.json`, and `.sha256` checksums. The runtime and provider dependencies are prebuilt. End-user installation needs no Pi CLI, backend server, TypeScript compilation, Python, or `npm install`. Repository marketplace distribution is separate from OpenAI's public plugin directory.

## Local installation

The repository includes the compiled executable. For a modified checkout, follow the [build instructions](../README.md#build-and-verify) first, then install this repository as a local Codex marketplace:

```bash
codex plugin marketplace add /absolute/path/pi-worker-plugin
codex plugin add pi-agents@pi-worker-plugin
```

Start a fresh session and select `pi-agents:pi-agents`. Node on the host PATH must be `>=24.15 <25`. No Pi CLI, backend server, or startup dependency download is needed.

Use `pi_health` from Codex for read-only prerequisites. From the plugin directory, run `node ./bin/pi-agents.mjs doctor`; installation does not add a global shell executable. Packaging smoke verifies relocation and MCP launch, but does not prove marketplace installation in a fresh client.

## Private configuration

Set `PI_AGENTS_CONFIG` to an absolute JSON configuration file. By default it is `config.json` in the state directory. Set `PI_AGENTS_STATE_DIR` to relocate state. macOS defaults to `~/Library/Application Support/pi-agents`; Linux defaults to `$XDG_STATE_HOME/pi-agents` or `~/.local/state/pi-agents`.

A keyless local OpenAI-compatible server:

```json
{
  "schema_version": 1,
  "project_roots": ["/absolute/projects"],
  "read_roots": [],
  "providers": {
    "local": {
      "kind": "openai-compatible",
      "base_url": "http://127.0.0.1:8124/v1",
      "api": "openai-completions",
      "models": {
        "my-model": { "context_window": 131072, "max_tokens": 16384, "reasoning": false, "input": ["text"] }
      }
    }
  },
  "models": {
    "standard": { "provider_id": "local", "model_id": "my-model", "destination": "local" }
  },
  "limits": {
    "concurrency": 2,
    "queue_timeout_seconds": 600,
    "execution_timeout_seconds": 1800,
    "finalization_timeout_seconds": 60,
    "artifact_bytes": 52428800
  }
}
```

Pi 1.5.0's OpenAI transport requires a nonempty key. For a loopback provider without `api_key_env`, the adapter supplies the non-secret placeholder `pi-local`. Non-local endpoints require a credential environment variable.

Native provider kinds are `openai`, `anthropic`, `google`, and `openrouter`. Set `base_url` explicitly and `api_key_env` to the name of an environment variable available to the supervisor. Select a model in Pi's pinned catalog. Common endpoints are `https://api.openai.com/v1`, `https://api.anthropic.com`, `https://generativelanguage.googleapis.com`, and `https://openrouter.ai/api/v1`. Hosted model `destination` must equal the configured base URL. Custom providers support `openai-completions` (default) and `openai-responses`, with explicit model metadata.

```json
{
  "kind": "anthropic",
  "base_url": "https://api.anthropic.com",
  "api_key_env": "ANTHROPIC_API_KEY"
}
```

Credentials remain in the host environment. Their values are not stored in launch contracts or included in shell-tool environments. Provider IDs and model aliases are operator-defined. OAuth login, auth-file discovery, attached services, and project extension discovery are unsupported.

## Shell readiness

Workers inherit the daemon's PATH, LANG, LC_ALL, and TERM, with private HOME and TMPDIR beneath their report directory. Shell strings run `/bin/bash --noprofile --norc`; login-shell startup files and version-manager activation are not loaded. An absent PATH remains empty. A supported Node executable in the parent shell does not establish daemon executable discovery. Start or restart the resolved daemon from the operator's intended supported environment; no worker input can choose an executable profile or change frozen policy.

Use MCP `pi_health` with `shell_preflight: true` to inspect the daemon environment without inference. `pi-agents doctor --shell-preflight` probes its local process instead, explicitly labelled `local_process`. Normal health/doctor calls omit these probes. The optional response reports shell mode, PATH Node availability/version and whether it resolves to the supervisor executable, private file usability, and local Unix IPC usability. It exposes no raw PATH, HOME, credentials, or arbitrary command arguments. Every probe is bounded and its newly allocated private directory is removed.

Preflight is representative: project dependencies, exact report-path length, and assigned test commands require their own authorized checks. A writable private directory can still fail IPC due to socket-path length or host restrictions. Capture the first exit code and original bounded stderr before a retry, distinguishing missing/unsupported executables, temp/IPC facilities, dependency access, actual assertion failure, and interrupted effects. Do not infer a production fix from a PATH override or `TMPDIR=/tmp` experiment. Symlink file access remains prohibited; approving a shell command that uses shared dependencies is a separate exact decision. A completed command with a nonzero exit is preserved as a known process result; interrupted or ambiguous effects remain uncertain.

## Policy and recovery

Health and `dry_run` never start inference. Live admission freezes the selected route, policy, model, and instructions. Existing tasks retain this contract after configuration changes. A follow-up must preserve the model route and profile; it may declare new scoped writes and receives a new report directory.

`bounded-inspect` permits scoped reads, progress, and assigned report writes. `bounded-build` permits declared file edits after parent permission and explicit parent-approved shell/network operations. Symlink paths are rejected. File tools enforce these bounds; approved arbitrary shell commands run as host-user code and are not an operating-system filesystem or network sandbox. The parent must review the command's requested effects before approval.

Each task has exclusive Pi storage ownership and an owned worker process group. Supervisor restart reconnects to a surviving worker. Worker restart reopens the same SQLite store after confirming the prior owner and process group stopped. Submission IDs deduplicate dispatch. Permission gates survive restart; an interrupted nested effect is not replayed, and another attempt needs fresh approval.

Cancellation is durable. Observe the task until stop confirmation and finalization; a transport timeout is not cancellation. Unknown process identity or uncertain stopping retains reservations for operator recovery. Do not remove state or ownership records while tasks are unresolved.

Build workers have `webfetch` and DuckDuckGo `websearch` tools. Each request needs parent permission, returns at most 64 KiB of response text, and does not follow redirects. Network effects use the same non-replayable nested execution as file and shell effects.

Set `PI_AGENTS_CAPTURE_DIAGNOSTICS=1` to retain bounded permission and effect-status diagnostics. These contain operation IDs and outcomes, without query text, file contents, or shell output. Capture is advisory and may have gaps or repeated status lines across reconnection. The supervisor retains at most 64 KiB per execution for seven days; use the task diagnostic cursor to read it.

## Upgrade and rollback

In 0.2.0, `pi_read_artifact` returns one body field and a resolved `encoding`; clients requiring exact bytes must request `encoding: "base64"`. CLI export does this automatically. The new `pi_prepare_review` tool is read-only. SQLite schema 4 replaces globally keyed native permission IDs with `(execution_id, request_id)` and retains denial explanations. Opening an older durable store first creates a private, WAL-consistent database backup under its `backups` directory, then migrates transactionally. Pending, responding, responded, unconfirmed, and expired requests and existing reply keys are preserved. Backup/migration failure stops opening without a partial schema upgrade. Pi Durable remains 1.5.0.

Before updating, reconcile active tasks, stop resolved workers and the daemon, and preserve the state database and reports. Do not run two plugin versions against the same state directory. Refresh a configured marketplace with `codex plugin marketplace upgrade pi-worker-plugin`; when changing a pinned release, select the new `--ref` explicitly and start a fresh Codex session. Uninstalling the plugin does not cancel accepted work or delete evidence.

Keep this plugin's state separate from OpenCode state. There is no OpenCode database migration. Back up the state directory only after stopping resolved workers and the daemon. Install an earlier Pi bundle and restore a matching backup to roll back; do not open newer schemas with older code. Pi dependencies are pinned because their upstream API is experimental.
