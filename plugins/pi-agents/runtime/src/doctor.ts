import { existsSync } from "node:fs";
import { configurationPath, loadConfiguration, stateDirectory } from "./config.js";
import { PI_VERSION } from "./launch-config.js";
import { createWorkerModels } from "./pi-models.js";
export function doctor() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const result = {
    runtime: { node: process.versions.node, supportedNode: major === 24 && minor! >= 15 && process.platform !== "win32", toolkit: "0.1.0" },
    configuration: { path: configurationPath(), status: "missing" as "missing" | "invalid" | "valid", message: "" },
    backend: { mode: "managed", binary: null, version: PI_VERSION, configuredModels: [] as string[],
      supportedVersions: [PI_VERSION], supportedForExecution: false },
    storage: { path: stateDirectory(), exists: existsSync(stateDirectory()) },
  };
  if (!existsSync(result.configuration.path)) return result;
  try {
    const config = loadConfiguration();
    result.backend.configuredModels = Object.keys(config.models);
    if (!result.backend.configuredModels.length) throw new Error("configure at least one model");
    for (const model of Object.values(config.models)) {
      const provider = config.providers[model.provider_id];
      if (!provider) throw new Error("selected provider is missing");
      // Catalog/auth validation performs no network calls or model inference.
      createWorkerModels({ version: PI_VERSION, workspace: "", reportPath: "", model, providers: { [model.provider_id]: provider }, profile: "bounded-inspect", readRoots: [], writes: [], maxTurns: 50 });
    }
    result.configuration.status = "valid";
    result.backend.supportedForExecution = result.runtime.supportedNode;
  } catch (error) { result.configuration.status = "invalid"; result.configuration.message = String(error); }
  return result;
}
export async function doctorAsync() { return doctor(); }
