import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { TaskPacketSchema } from "../contracts.js";

test("complete inspect audit example fits the packet contract and leaves commands with the parent", () => {
  const packet = TaskPacketSchema.parse(JSON.parse(readFileSync(new URL("../../../skills/pi-agents/assets/audit-inspect.packet.json", import.meta.url), "utf8")));
  assert.equal(packet.authoritative_inputs.length, 8);
  assert.deepEqual(packet.allowed_writes, []);
  assert.ok(packet.checks.every(check => check.argv === undefined && check.cwd === undefined));
  assert.match(packet.objective, /Sampling any required input leaves required coverage unmet/);
});
