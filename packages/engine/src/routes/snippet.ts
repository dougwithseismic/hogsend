import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../app.js";
import { type LoadedSnippet, loadSnippet } from "../lib/snippet.js";

// The drop-in browser snippet, root-mounted as `/hogsend.js` so the tag a
// non-bundler site pastes is just `${API_PUBLIC_URL}/hogsend.js`. Public and
// unauthenticated by construction (it is the SDK itself; the publishable key
// travels on the tag, not the request). Collides with nothing (`/v1`, `/l`,
// `/s`, `/studio`, `/docs`, `/api/auth`, `/connectors`, webhooks).
export const SNIPPET_PATH = "/hogsend.js";

const snippetRoute = createRoute({
  method: "get",
  path: SNIPPET_PATH,
  tags: ["SDK"],
  summary: "Drop-in browser SDK script",
  responses: {
    200: { description: "The @hogsend/js IIFE bundle" },
    304: { description: "Not modified" },
    404: { description: "Snippet asset not installed" },
  },
});

/**
 * Cache policy: five minutes fresh, a day stale-while-revalidate, strong ETag.
 * A deploy with a newer `@hogsend/js` is picked up within minutes by every
 * page without a cache-busting URL, and a revalidation is a 304 with no body.
 */
export const SNIPPET_CACHE_CONTROL =
  "public, max-age=300, stale-while-revalidate=86400";

export function createSnippetRouter(
  snippet: LoadedSnippet | null = loadSnippet(),
): OpenAPIHono<AppEnv> {
  return new OpenAPIHono<AppEnv>().openapi(snippetRoute, (c) => {
    if (!snippet) {
      return c.json(
        {
          error:
            "hogsend.js is not installed on this engine. Add @hogsend/js as a dependency (or set HOGSEND_JS_PATH).",
        },
        404,
      );
    }
    // Explicit CORP so a cross-origin <script src> load is allowed (app.ts
    // exempts this path from secureHeaders, which would force same-origin).
    c.header("Cross-Origin-Resource-Policy", "cross-origin");
    c.header("Cache-Control", SNIPPET_CACHE_CONTROL);
    c.header("ETag", snippet.etag);
    c.header("Vary", "Accept-Encoding");

    if (c.req.header("if-none-match") === snippet.etag) {
      return c.body(null, 304);
    }
    c.header("Content-Type", "application/javascript; charset=utf-8");
    return c.body(snippet.body, 200);
  });
}
