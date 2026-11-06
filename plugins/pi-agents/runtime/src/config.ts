import { readFileSync, realpathSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, dirname, resolve, relative } from "node:path";
import { z } from "zod";

const AbsolutePath = z.string().min(1).refine(isAbsolute, "must be absolute");
export const ProviderSchema = z.object({
  kind: z.enum(["openai", "anthropic", "google", "openrouter", "openai-compatible"]),
  base_url: z.string().url(),
  api_key_env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  api: z.enum(["openai-completions", "openai-responses"]).optional(),
  models: z.record(z.string().min(1), z.object({
    context_window: z.number().int().positive(),
    max_tokens: z.number().int().positive(),
    reasoning: z.boolean().default(false),
    input: z.array(z.enum(["text", "image"])).min(1).default(["text"]),
  }).strict()).optional(),
}).strict();

export const UserConfigSchema = z.object({
  schema_version: z.literal(1),
  project_roots: z.array(AbsolutePath).min(1),
  read_roots: z.array(AbsolutePath),
  providers: z.record(z.string().min(1), ProviderSchema),
  models: z.record(z.string().min(1), z.object({
    provider_id: z.string().min(1),
    model_id: z.string().min(1),
    destination: z.string().min(1),
  }).strict()),
  limits: z.object({
    concurrency: z.number().int().min(1).max(16).default(2),
    queue_timeout_seconds: z.number().int().positive().default(600),
    execution_timeout_seconds: z.number().int().positive().default(1800),
    finalization_timeout_seconds: z.number().int().positive().default(60),
    artifact_bytes: z.number().int().positive().default(50 * 1024 * 1024),
  }).strict().default({ concurrency: 2, queue_timeout_seconds: 600, execution_timeout_seconds: 1800,
    finalization_timeout_seconds: 60, artifact_bytes: 50 * 1024 * 1024 }),
}).strict();

export type UserConfig = z.infer<typeof UserConfigSchema>;

export function stateDirectory(): string {
  if (process.env.PI_AGENTS_STATE_DIR) {
    const requested = process.env.PI_AGENTS_STATE_DIR;
    if (!isAbsolute(requested)) throw new Error("PI_AGENTS_STATE_DIR must be absolute");
    let parent = resolve(requested);
    while (!existsSync(parent)) parent = dirname(parent);
    return resolve(realpathSync(parent), relative(parent, requested));
  }
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "pi-agents");
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "pi-agents");
}

export function configurationPath(): string {
  return process.env.PI_AGENTS_CONFIG ?? join(stateDirectory(), "config.json");
}

export function loadConfiguration(path = configurationPath()): UserConfig {
  return UserConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
