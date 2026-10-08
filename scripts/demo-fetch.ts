// A fetch() that serves demo/site as if it were hosted at https://demo.rssa.getvda.ai.
// Used by tests and `npm run check` so they run offline and deterministically.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
export const DEMO_BASE = "https://demo.rssa.getvda.ai";

export function demoFetch(overrides: Record<string, string | null> = {}, log?: string[]) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    log?.push(`${init?.method ?? "GET"} ${url}`);
    if (url in overrides) {
      const body = overrides[url];
      return body === null ? new Response("gone", { status: 404 }) : new Response(body, { status: 200 });
    }
    if (!url.startsWith(DEMO_BASE)) return new Response("not found", { status: 404 });
    const file = join(root, "demo", "site", ...new URL(url).pathname.split("/").filter(Boolean));
    if (!existsSync(file)) return new Response("not found", { status: 404 });
    return new Response(readFileSync(file, "utf8"), { status: 200, headers: { etag: `"${file.length}"` } });
  };
}
