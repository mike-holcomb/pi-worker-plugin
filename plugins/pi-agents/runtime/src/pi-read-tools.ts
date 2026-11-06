import { defineTool, type ToolRegistration, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { obj, str, opt } from "@earendil-works/pi-schema";
import { readdirSync, lstatSync, readFileSync } from "node:fs";
import { join, relative, matchesGlob } from "node:path";
import { checkedPath } from "./pi-env.js";
import type { FrozenPolicy } from "./launch-config.js";
import type { Context } from "@earendil-works/chord/context";

const text = (value: unknown) => ({ output: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] });
export function readTools(policyFor: (api: ToolExecutionApi, context: Context) => Promise<FrozenPolicy>): ToolRegistration[] {
  const files = (policy: FrozenPolicy, root: string) => {
    const result: string[] = []; let visited = 0;
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (++visited > 5000) return;
        if (entry.name === ".git" || entry.isSymbolicLink()) continue;
        const path = checkedPath(policy, join(dir, entry.name));
        if (entry.isDirectory()) walk(path); else if (entry.isFile()) result.push(path);
      }
    };
    walk(root); return { result, truncated: visited > 5000 };
  };
  return [
    defineTool({ name: "list", description: "List at most 200 entries of a permitted directory; symlinks are omitted.",
      parameters: obj({ path: opt(str()) }), replay: "safe", execute: async (args, api, ctx) => {
        const policy = await policyFor(api, ctx); const path = checkedPath(policy, args.path ?? ".");
        const entries = readdirSync(path, { withFileTypes: true }).filter(e => !e.isSymbolicLink());
        return text({ entries: entries.slice(0, 200).map(e => ({ name: e.name, directory: e.isDirectory() })), truncated: entries.length > 200 });
      } }),
    defineTool({ name: "glob", description: "Find files in a permitted directory by a glob pattern. Walks at most 5000 entries and returns at most 200 paths.",
      parameters: obj({ pattern: str(), path: opt(str()) }), replay: "safe", execute: async (args, api, ctx) => {
        const policy = await policyFor(api, ctx); const path = checkedPath(policy, args.path ?? ".");
        const all = files(policy, path); const matches = all.result.map(p => relative(path, p)).filter(p => matchesGlob(p, args.pattern));
        return text({ paths: matches.slice(0, 200), truncated: all.truncated || matches.length > 200 });
      } }),
    defineTool({ name: "grep", description: "Find a literal text query in permitted files. Returns at most 100 matches; files over 256 KiB are skipped with a coverage note.",
      parameters: obj({ query: str(), path: opt(str()), glob: opt(str()) }), replay: "safe", execute: async (args, api, ctx) => {
        if (!args.query || args.query.length > 1000) throw new Error("query must contain 1..1000 characters");
        const policy = await policyFor(api, ctx); const root = checkedPath(policy, args.path ?? ".");
        const all = lstatSync(root).isDirectory() ? files(policy, root) : { result: [root], truncated: false };
        const matches: Array<{ path: string; line: number; text: string }> = []; let skipped = 0;
        for (const path of all.result) {
          if (args.glob && !matchesGlob(relative(root, path), args.glob)) continue;
          checkedPath(policy, path);
          if (lstatSync(path).size > 256 * 1024) { skipped++; continue; }
          const content = readFileSync(path, "utf8"); if (content.includes("\0")) { skipped++; continue; }
          const lines = content.split("\n");
          for (let index = 0; index < lines.length; index++) if (lines[index]!.includes(args.query)) {
            matches.push({ path: relative(policy.workspace, path), line: index + 1, text: lines[index]!.slice(0, 500) });
            if (matches.length === 100) break;
          }
          if (matches.length === 100) break;
        }
        return text({ matches, skipped_files: skipped, truncated: all.truncated || matches.length === 100 });
      } }),
  ];
}
