import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freezeManagedLaunch, assertFrozenEffectiveConfig, assertSelectedModelDestination, policyNeutralConfigHash, type FrozenPolicy } from "../launch-config.js";
import { UserConfigSchema } from "../config.js";
import { TaskPacketSchema } from "../contracts.js";
import { checkedPath } from "../pi-env.js";

test("admission freezes only the selected route and preserves scoped inputs across follow-ups", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-launch-")));
  try {
    const workspace = join(root, "project"); mkdirSync(workspace);
    const input = join(root, "reference.txt"); writeFileSync(input, "reference");
    const config = UserConfigSchema.parse({ schema_version: 1, project_roots: [root], read_roots: [],
      providers: { local: { kind: "openai-compatible", base_url: "http://127.0.0.1:8124/v1", models: {
        model: { context_window: 32000, max_tokens: 4096 } } }, unused: { kind: "openai", base_url: "https://api.openai.com/v1" } },
      models: { local: { provider_id: "local", model_id: "model", destination: "local" } } });
    const packet = TaskPacketSchema.parse({ title: "Inspect", objective: "Read reference", tier: "lightweight",
      authoritative_inputs: [{ kind: "file", reference: input, purpose: "Reference" }],
      context: { verified_facts: [], rejected_assumptions: [], exclusions: [] }, allowed_writes: [],
      acceptance_criteria: [], checks: [], constraints: [], stop_conditions: [], shared_resources: [] });
    const first = await freezeManagedLaunch(config, workspace, join(root, "exec_one"), config.models.local!, "bounded-build", packet);
    const policy = JSON.parse(first.configContent) as FrozenPolicy;
    assert.deepEqual(Object.keys(policy.providers), ["local"]);
    assert.equal(checkedPath(policy, input), input);
    assert.throws(() => checkedPath(policy, join(root, "another.txt")), /outside/);
    assert.throws(() => assertFrozenEffectiveConfig({ ...policy, maxTurns: 10 }, first), /changed/);
    const follow = await freezeManagedLaunch(config, workspace, join(root, "exec_two"), config.models.local!, "bounded-build",
      { ...packet, allowed_writes: [{ path: "output.txt", kind: "file", purpose: "Output" }] });
    assert.equal(policyNeutralConfigHash(first), policyNeutralConfigHash(follow));
    assert.equal(checkedPath(JSON.parse(follow.configContent), "output.txt", true), join(workspace, "output.txt"));
    config.providers.local!.base_url = "http://127.0.0.1:9999/v1";
    const drift = await freezeManagedLaunch(config, workspace, join(root, "exec_three"), config.models.local!, "bounded-build", packet);
    assert.notEqual(policyNeutralConfigHash(first), policyNeutralConfigHash(drift));
    assert.throws(() => assertSelectedModelDestination({ ...config.models.local!, destination: "https://other.example/v1" }, first), /differs/);
    config.providers.local!.base_url = "https://remote.example/v1";
    await assert.rejects(freezeManagedLaunch(config, workspace, join(root, "exec_four"), config.models.local!, "bounded-build", packet), /local destination/);
    await assert.rejects(freezeManagedLaunch(config, workspace, join(root, "exec_five"), config.models.local!, "bounded-build",
      { ...packet, allowed_writes: [{ path: "/outside/output", kind: "file", purpose: "Invalid" }] }), /outside/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
