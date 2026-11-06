# GitHub release preparation

Pi Agents is distributed through this repository's Codex marketplace. The current candidate is `v0.2.0`; `v0.1.0` is published. Repository changes, a pushed tag, a draft release, and publication are separate steps. This process does not submit the plugin to OpenAI's public directory.

## Prepare the candidate

Keep `.codex-plugin/plugin.json`, runtime `package.json` and lockfile, `compatibility.json`, diagnostic and MCP versions, changelog, and release notes consistent. Run the repository metadata check from the root:

```bash
node scripts/validate-release.mjs v0.2.0
```

Use Node.js 24.15 or later within 24.x. CI tests Node 24.15.0 and 24.22.1 on macOS 15 and Ubuntu 24.04. From the repository root, build and validate:

```bash
cd plugins/pi-agents/runtime
npm ci --ignore-scripts
npm run check
npm run bundle
npm test
cd ..
node scripts/build_bundle.mjs --check
node --test tests/packaging.test.mjs evaluation/harness.test.mjs
node evaluation/harness.mjs validate
node scripts/build_bundle.mjs --out /tmp/pi-agents-v0.2.0.zip
node scripts/smoke_installed_bundle.mjs /tmp/pi-agents-v0.2.0.zip
```

Each archive output path must be new. The builder emits a ZIP, `.manifest.json`, and `.sha256` sidecar. Keep all three together and verify checksums from their directory. The smoke test runs without live inference. Build from the final clean release commit; local candidate artifacts do not prove a later tag.

## Prepare a GitHub draft

After the reviewed changes reach `main` and CI passes, create and push an annotated tag identifying that tested commit:

```bash
git tag -a v0.2.0 -m 'Pi Agents v0.2.0'
git push origin v0.2.0
```

The `Prepare draft release` workflow checks out that tag, verifies metadata, runs the four-platform/Node validation matrix, and creates a draft with the three checked Ubuntu/Node 24.15.0 assets and `docs/releases/v0.2.0.md` as notes. It grants write access only to the draft job; repository workflow permissions remain read-only. Existing releases are not overwritten.

For an existing tag, start the same workflow manually:

```bash
gh workflow run release.yml --ref main -f tag=v0.2.0
```

Alternatively, create a draft from freshly validated local assets:

```bash
gh release create v0.2.0 /tmp/pi-agents-v0.2.0.zip \
  /tmp/pi-agents-v0.2.0.zip.manifest.json \
  /tmp/pi-agents-v0.2.0.zip.sha256 \
  --repo mike-holcomb/pi-worker-plugin \
  --draft --verify-tag --latest=false --title 'Pi Agents v0.2.0' \
  --notes-file docs/releases/v0.2.0.md
```

## Review and publish

Inspect the draft's exact tag, notes, three asset names, and checksums. Verify final-tag marketplace installation in a fresh Codex client using the commands in the release notes, and record results independently of ZIP smoke. Preserve the [validation limits](../plugins/pi-agents/docs/validation.md); release publication does not certify untested provider behavior.

After release review, publish the draft:

```bash
gh release edit v0.2.0 --repo mike-holcomb/pi-worker-plugin --draft=false --latest
```

Update candidate wording in the root README, installation guide, and release notes to name the published release. GitHub release notes and repository docs should identify the same current version. Leave previous immutable tags available for rollback.

The marketplace retains the repository-relative `./plugins/pi-agents` source, so a pinned Git ref selects the catalog and compiled plugin from the same commit. See [official packaging guidance](https://developers.openai.com/plugins/build/plugins) for the catalog format.
