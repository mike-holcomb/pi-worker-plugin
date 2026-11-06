import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { UserConfig } from "./config.js";
import type { TaskPacket } from "./contracts.js";
import { resolveDeclaredPath } from "./workspace.js";
export const PI_VERSION = "1.5.0";
export type SelectedModel = { provider_id: string; model_id: string; destination: string };
export type FrozenPolicy = {
  version: string; workspace: string; providers: UserConfig["providers"];
  model: SelectedModel; profile: "bounded-build" | "bounded-inspect";
  readRoots: string[]; inputPaths?: string[]; writes: Array<{ path: string; kind: "file" | "directory" }>;
  reportPath: string; maxTurns: number;
};
export type ManagedLaunchContract = { configContent: string; effectiveConfigSha256: string; reportPath: string };
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const r = value as Record<string, unknown>;
  return `{${Object.keys(r).sort().map(k => `${JSON.stringify(k)}:${canonical(r[k])}`).join(",")}}`;
}
export function effectiveConfigHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function policyNeutralConfigHash(contract: ManagedLaunchContract): string {
  const { reportPath: _report, writes: _writes, inputPaths: _inputs, ...policy } = JSON.parse(contract.configContent) as FrozenPolicy;
  return effectiveConfigHash(policy);
}
export function assertFrozenEffectiveConfig(value: unknown, contract: ManagedLaunchContract): void {
  if (effectiveConfigHash(value) !== contract.effectiveConfigSha256) throw new Error("Pi launch configuration changed since admission");
}
export function assertSelectedModelDestination(model: SelectedModel, contract: ManagedLaunchContract): void {
  const policy = JSON.parse(contract.configContent) as FrozenPolicy;
  const provider = policy.providers[model.provider_id];
  if (!provider) throw new Error("provider is not configured");
  const actual = new URL(provider.base_url);
  if (actual.username || actual.password || actual.hash || actual.search) throw new Error("provider URL must not contain credentials, query, or fragment");
  if (model.destination === "local") {
    if (actual.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(actual.hostname)) throw new Error("provider is not routed to the declared local destination");
  } else if (actual.href.replace(/\/$/, "") !== new URL(model.destination).href.replace(/\/$/, "")) throw new Error("provider route differs from declared destination");
  if (provider.kind === "openai-compatible" && !provider.models?.[model.model_id]) throw new Error("custom model metadata is missing");
}
export async function freezeManagedLaunch(config: UserConfig, workspace: string, reportPath: string,
  model: SelectedModel, profile: FrozenPolicy["profile"], packet: TaskPacket): Promise<ManagedLaunchContract> {
  const roots = config.project_roots.map(p => realpathSync(p));
  const policy: FrozenPolicy = { version: PI_VERSION, workspace, reportPath, model, profile,
    providers: { [model.provider_id]: config.providers[model.provider_id]! }, maxTurns: 50,
    readRoots: [workspace, ...config.read_roots.map(p => realpathSync(p))],
    inputPaths: packet.authoritative_inputs.filter(i => i.kind === "file").map(i => resolveDeclaredPath(workspace, i.reference, [...roots, ...config.read_roots.map(p => realpathSync(p))])),
    writes: packet.allowed_writes.map(w => ({ kind: w.kind, path: resolveDeclaredPath(workspace, w.path, roots) })) };
  const contract = { reportPath, configContent: JSON.stringify(policy), effectiveConfigSha256: effectiveConfigHash(policy) };
  assertSelectedModelDestination(model, contract);
  return contract;
}
