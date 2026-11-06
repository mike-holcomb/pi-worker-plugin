# Read-only audit with explicit coverage and check ownership

Use [the complete typed packet](audit-inspect.packet.json) as an example, replacing its eight fixture references with the actual agreed inventory and required checks. It is also exercised by the frozen `audit-complete` evaluation fixture. The packet is a `packet` object, not an entire start request. Launch separately with `profile: "bounded-inspect"`, `workspace.access: "shared_read"`, a configured model, limits, scope, and a caller-generated operation key.

Every listed file requires a full read in this example; each root/plugin/skill comparison is required. For larger repositories, agree narrower targeted checks or an explicit sample before dispatch. A directory name or generic completeness percentage does not establish inspected coverage. Require each file/check to be reported as `inspected`, `sampled`, or `not-inspected`, with references, actual bounds, and omission reasons. Missing required reads/checks remain unmet coverage even if the worker reports useful findings. The parent compares this actual coverage with every required bound before accepting; use `awaiting_evidence` or `needs_correction` when required coverage is missing.

## Worker static checks

The packet's `checks` use descriptions without `argv`. The worker reads metadata and source documents, performs static comparisons, reports original-source findings and contrary evidence, and publishes bounded milestone progress. It cannot run shell commands or contact external endpoints. Report output goes through `write_report`, not `allowed_writes`.

## Parent commands and captured freshness

The parent independently runs applicable authorized read-only checks before dispatch and after completion, for example:

```sh
git rev-parse HEAD
git status --short
```

Run existing project validators in the parent when they are authorized and appropriate; preserve their actual commands and results. Keep these commands outside inspect-mode worker `checks`: declaring `argv` does not grant execution. Put parent-run verification and its evidence in the parent review's `integration_checks`, and explain live freshness in `freshness`. A valid worker report does not prove a parent command passed.

The supervisor captures the starting state and final manifest. Retain the returned exact execution identity and capture hashes; inspect the frozen report, summary, manifest, and relevant diff artifacts. Compare captures with the live workspace and relevant initial dirty state before review. Supervisor captures and parent commands are different evidence sources; a Git revision alone does not describe uncommitted contents.

For a qualitative audit, inspect original source support for each adopted finding and any contrary evidence. If scope changes or an input is missing, negotiate a correction rather than accepting a claimed exhaustive result. Use exact execution-bound artifact citations for an accepted review and keep explanatory prose in its rationale/freshness/integration fields.
