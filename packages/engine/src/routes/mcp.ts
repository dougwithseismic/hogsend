import type { AdminClient, Query } from "@hogsend/mcp";
import { createHogsendMcpServer } from "@hogsend/mcp";
import { StreamableHTTPTransport } from "@hono/mcp";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../app.js";
import { requireAdmin } from "../middleware/require-admin.js";

/**
 * Remote MCP over Streamable HTTP, mounted ON the engine at `POST /mcp` (P2 of
 * the MCP plan) — what claude.ai custom connectors and Claude Desktop reach
 * with plain `Authorization: Bearer <admin key>` header auth (OAuth 2.1 is the
 * later, connectors-directory step).
 *
 * Design:
 *  - STATELESS: a fresh `McpServer` + transport per request (no session ids),
 *    so the engine stays horizontally scalable and a replica restart loses
 *    nothing. Building the 3-tool server per request is cheap.
 *  - The tool registry is the SAME one the stdio entry uses — only the
 *    AdminClient differs: here it dispatches IN-PROCESS via `app.request()`
 *    back into `/v1/admin/*`, so every tool effect still traverses the full
 *    requireAdmin → rateLimit → audit middleware stack with the caller's own
 *    credential. The MCP layer adds no privilege and bypasses no control.
 *  - Auth is the engine's own `requireAdmin` on the route itself (401 before
 *    any protocol handling), then re-enforced per tool call by the in-process
 *    dispatch carrying the same Authorization header.
 *
 * Gated by `MCP_HTTP_ENABLED=true` (default off — remote MCP is an explicit
 * operator opt-in). `MCP_HTTP_MODE=read` serves the read-only toolset.
 */
export function registerMcpRoute(app: OpenAPIHono<AppEnv>): void {
  if (process.env.MCP_HTTP_ENABLED !== "true") return;

  const mode = process.env.MCP_HTTP_MODE === "read" ? "read" : "write";

  app.all("/mcp", requireAdmin, async (c) => {
    const authorization = c.req.header("authorization") ?? "";
    const publicUrl = c.get("container").env.API_PUBLIC_URL;

    const client: AdminClient = {
      baseUrl: publicUrl,
      get: (path: string, query?: Query) =>
        dispatch(app, authorization, "GET", withQuery(path, query)),
      post: (path: string, body: unknown) =>
        dispatch(app, authorization, "POST", path, body),
      put: (path: string, body: unknown, query?: Query) =>
        dispatch(app, authorization, "PUT", withQuery(path, query), body),
      patch: (path: string, body: unknown) =>
        dispatch(app, authorization, "PATCH", path, body),
    };

    const server = createHogsendMcpServer({ client, mode });
    // Stateless transport: no session id, no resumability — one request, one
    // protocol exchange. Matches the SDK's stateless Streamable HTTP mode.
    const transport = new StreamableHTTPTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    const res = await transport.handleRequest(c);
    return res ?? c.body(null, 202);
  });
}

function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** In-process admin dispatch — same wire semantics as the fetch client. */
async function dispatch<T>(
  app: OpenAPIHono<AppEnv>,
  authorization: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await app.request(path, {
    method,
    headers: {
      authorization,
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: unknown;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const message =
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof (parsed as { error: unknown }).error === "string"
        ? `${res.status}: ${(parsed as { error: string }).error}`
        : `request failed with status ${res.status}`;
    const err = new Error(message) as Error & { status: number; body: unknown };
    err.name = "HttpError";
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed as T;
}
