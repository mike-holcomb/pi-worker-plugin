#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const json = (path) => JSON.parse(read(path));
const plugin = "plugins/pi-agents";
const manifest = json(`${plugin}/.codex-plugin/plugin.json`);
const version = manifest.version;
const tag = process.argv[2] || `v${version}`;

assert.match(version, /^\d+\.\d+\.\d+$/, "release version must be stable semver");
assert.equal(tag, `v${version}`, "tag must match the plugin version");
assert.equal(manifest.name, "pi-agents");
assert.equal(manifest.skills, "./skills/");
assert.equal(manifest.mcpServers, "./.mcp.json");
assert.equal(manifest.license, "MIT");
for (const key of ["homepage", "repository"])
  assert.equal(manifest[key], "https://github.com/mike-holcomb/pi-worker-plugin");

const runtime = json(`${plugin}/runtime/package.json`);
const lock = json(`${plugin}/runtime/package-lock.json`);
const compatibility = json(`${plugin}/compatibility.json`);
assert.equal(runtime.version, version, "runtime version differs");
assert.equal(lock.version, version, "lockfile version differs");
assert.equal(lock.packages[""].version, version, "lockfile root version differs");
assert.equal(compatibility.plugin_version, version, "compatibility version differs");
assert.equal(runtime.engines.node, ">=24.15 <25");
assert.equal(compatibility.node, runtime.engines.node);
assert.equal(runtime.dependencies["@earendil-works/pi-durable"], compatibility.library_version);
assert.ok(read(`${plugin}/runtime/src/mcp.ts`).includes(`name: "pi-agents", version: "${version}"`), "MCP version differs");
assert.ok(read(`${plugin}/runtime/src/doctor.ts`).includes(`toolkit: "${version}"`), "diagnostic version differs");
assert.ok(read(`${plugin}/CHANGELOG.md`).includes(`\n## ${version}\n`), "changelog entry missing");
assert.ok(read(`docs/releases/${tag}.md`).startsWith(`# Pi Agents ${tag}\n`), "release notes missing or misnamed");

const catalog = json(".agents/plugins/marketplace.json");
assert.equal(catalog.name, "pi-worker-plugin");
assert.equal(catalog.interface.displayName, "Pi Worker Plugin");
assert.equal(catalog.plugins.length, 1);
assert.deepEqual(catalog.plugins[0], {
  name: "pi-agents",
  source: { source: "local", path: "./plugins/pi-agents" },
  policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
  category: "Productivity",
});
assert.equal(manifest.interface.displayName, "Pi Agents");
assert.equal(manifest.interface.category, catalog.plugins[0].category);
assert.ok(manifest.interface.shortDescription.length <= 64, "short description is too long");
assert.deepEqual(manifest.interface.defaultPrompt, [
  "Use $pi-agents:pi-agents to prepare a bounded task, monitor it, and verify the deliverable.",
]);
console.log(`Release metadata check passed: ${tag}`);
