import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";

/** Permission and unsafe replay handling are supplied by the outer harness gate. */
export function networkTools(): ToolRegistration[] {
  return ["webfetch", "websearch"].map(name => defineTool({
    name,
    description: name === "webfetch" ? "Fetch an HTTP(S) URL after parent permission; returns bounded response text." :
      "Search DuckDuckGo after parent permission; returns bounded HTML results with source links.",
    parameters: name === "webfetch" ? obj({ url: str() }) : obj({ query: str() }),
    execute: async (args, _api, ctx) => {
      const url = "url" in args ? new URL(args.url) : new URL("https://html.duckduckgo.com/html/");
      if ("query" in args) url.searchParams.set("q", args.query);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("invalid fetch URL");
      // Redirects require permission for a distinct URL and are never followed silently.
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.any([
        ctx.abortSignal ?? new AbortController().signal, AbortSignal.timeout(30_000),
      ]) });
      const chunks: Buffer[] = []; let retained = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try { while (retained < 64 * 1024) {
          const part = await reader.read(); if (part.done) break;
          const bytes = Buffer.from(part.value).subarray(0, 64 * 1024 - retained);
          chunks.push(bytes); retained += bytes.length;
        } } finally { await reader.cancel(); }
      }
      const result = `HTTP ${response.status}\n${Buffer.concat(chunks).toString("utf8")}`;
      return { output: [{ type: "text", text: result }] };
    },
  }));
}
