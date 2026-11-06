import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { FrozenPolicy } from "./launch-config.js";

/** Only the explicitly selected provider is registered. No auth files or CLI discovery. */
export function createWorkerModels(policy: FrozenPolicy, env = process.env) {
  const models = createModels();
  for (const [id, config] of Object.entries(policy.providers)) {
    const key = config.api_key_env ? env[config.api_key_env] : undefined;
    if (config.api_key_env && !key) throw new Error(`missing provider credential environment variable: ${config.api_key_env}`);
    if (!key && config.kind !== "openai-compatible") throw new Error("hosted providers require api_key_env");
    const local = ["127.0.0.1", "[::1]", "localhost"].includes(new URL(config.base_url).hostname);
    if (!key && !local) throw new Error("non-local endpoints require api_key_env");
    // Pi 1.5's OpenAI transport requires a nonempty key even for keyless local servers.
    const resolvedKey = key ?? "pi-local";
    const auth = { apiKey: { name: id, resolve: async () => ({ auth: { apiKey: resolvedKey } }) } };
    let provider: Provider;
    if (config.kind === "openai-compatible") {
      const api = config.api ?? "openai-completions";
      const catalog: Model<"openai-completions" | "openai-responses">[] = Object.entries(config.models ?? {}).map(([modelId, m]) => ({
        id: modelId, name: modelId, provider: id, api, baseUrl: config.base_url,
        contextWindow: m.context_window, maxTokens: m.max_tokens, reasoning: m.reasoning, input: m.input,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }));
      provider = createProvider({ id, baseUrl: config.base_url, auth, models: catalog,
        api: api === "openai-responses" ? openAIResponsesApi() : openAICompletionsApi() });
    } else {
      const factories = { openai: openaiProvider, anthropic: anthropicProvider, google: googleProvider, openrouter: openrouterProvider };
      const native = factories[config.kind]();
      provider = { ...native, id, baseUrl: config.base_url, auth,
        getModels: () => native.getModels().map(m => ({ ...m, provider: id, baseUrl: config.base_url })),
        getAllModels: () => native.getModels().map(m => ({ ...m, provider: id, baseUrl: config.base_url })),
      };
    }
    models.setProvider(provider);
  }
  if (!models.getModel(policy.model.provider_id, policy.model.model_id)) throw new Error("selected model is absent from the pinned Pi catalog");
  return models;
}
