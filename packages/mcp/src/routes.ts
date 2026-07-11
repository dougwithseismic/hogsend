/**
 * `mcpRoutes()` — the CONSUMER-FACING hosted transport. A consumer mounts it on
 * their engine app via `createApp`'s existing `routes` option
 * (`routes: [mcpRoutes()]`), which serves the MCP server over Streamable HTTP at
 * `POST /v1/mcp` for claude.ai connectors / any Streamable-HTTP MCP client.
 *
 * Design (plan Phase 3):
 *  - The engine gains ZERO new deps — the SDK / `@hono/mcp` live here, in the
 *    consumer-mounted package, so the consumer-bundling boot-crash class (#263)
 *    is avoided entirely. This file MAY import the engine barrel (it runs inside
 *    the engine process where the server env exists); the STDIO bin must NEVER
 *    reach it (see the barrel note below).
 *  - STATELESS: a fresh `AdminClient` + `McpServer` + transport are built PER
 *    REQUEST. Registering 3 tools per request is cheap, and it keeps the hosted
 *    path sessionless (no server-side session store, no SSE stream to leak).
 *  - The in-process client re-issues each tool's admin call back through the
 *    SAME app with the CALLER's credential, so every call re-traverses
 *    `requireAdmin` → validation → audit — one auth story, zero parallel path.
 *
 * IMPORTANT — bin isolation: this module (and thus `index.ts`, which re-exports
 * it) pulls in `@hogsend/engine`'s barrel and `@hono/mcp`. The stdio `bin.ts`
 * MUST NOT import from here or from the package barrel, or the published bin
 * would drag the whole engine graph in. `bin.ts` imports `./server.js` +
 * `./lib/admin-client.js` directly for exactly this reason.
 */
import { createRateLimit, type RoutesFn, requireAdmin } from "@hogsend/engine";
import { StreamableHTTPTransport } from "@hono/mcp";
import { createInProcessAdminClient } from "./lib/in-process-client.js";
import { createHogsendMcpServer } from "./server.js";

/** The default mount path — the ecosystem convention for Streamable HTTP. */
const DEFAULT_PATH = "/v1/mcp";

/**
 * Per-key request cap. One MCP call == one agent action, so 60/min is generous
 * for a human-driven agent while capping an authenticated flood (each POST
 * builds a fresh server). NOTE: a single MCP call can itself fan out to several
 * admin sub-requests (`hogsend_report`) — but those hit `/v1/admin/*`, not this
 * mount, so they do NOT consume this budget.
 */
const DEFAULT_RATE_LIMIT_MAX = 60;

export interface McpRoutesOptions {
  /** Mount path for the Streamable HTTP endpoint. Default `/v1/mcp`. */
  path?: string;
  /**
   * Per-credential request cap per minute on the mount. Default
   * {@link DEFAULT_RATE_LIMIT_MAX} (60). Keyed on the resolved admin key / user
   * id, so one caller can't starve another.
   */
  rateLimitMax?: number;
}

/**
 * Build the hosted-transport route factory. Pass the result to `createApp`'s
 * `routes` option: `createApp(client, { routes: [mcpRoutes()] })`.
 */
export function mcpRoutes(options: McpRoutesOptions = {}): RoutesFn {
  const path = options.path ?? DEFAULT_PATH;
  // Own Redis namespace + memory store so the mount's budget never shares the
  // data-plane / email sliding windows.
  const mcpRateLimit = createRateLimit({
    prefix: "ratelimit:mcp",
    max: options.rateLimitMax ?? DEFAULT_RATE_LIMIT_MAX,
  });

  return (app) => {
    // Admin-gate EVERY method on the endpoint (the POST tool calls plus the
    // GET/DELETE a client may probe), THEN throttle — the limiter keys on the
    // resolved credential, so `requireAdmin` must run first (auth → rateLimit,
    // matching the admin data-plane's ordering). `requireAdmin` accepts a Bearer
    // admin key OR a Better-Auth session cookie; an unauthenticated request is
    // rejected before any MCP machinery is built.
    app.use(path, requireAdmin, mcpRateLimit);

    app.post(path, async (c) => {
      // Forward BOTH credential headers: the Authorization bearer (key path) and
      // the Cookie (session path). `createInProcessAdminClient` sends whichever
      // is present, so the tool's re-entrant admin calls authenticate exactly as
      // the inbound caller did.
      const client = createInProcessAdminClient({
        // `app.request` may return a `Response` synchronously; normalize to a
        // promise for the `Fetcher` contract.
        fetcher: (p, init) => Promise.resolve(app.request(p, init)),
        authorization: c.req.header("authorization") ?? "",
        cookie: c.req.header("cookie") ?? undefined,
      });

      const server = createHogsendMcpServer({ client });
      // `enableJsonResponse` returns a plain JSON-RPC response instead of an SSE
      // stream — the right shape for a stateless request/response server (no
      // dangling stream to clean up per request). Session id generation is left
      // off (stateless).
      const transport = new StreamableHTTPTransport({
        enableJsonResponse: true,
      });
      await server.connect(transport);

      // `handleRequest` returns a `Response` for every POST branch we reach; the
      // `?? 204` guards only its `Response | undefined` type.
      const res = await transport.handleRequest(c);
      return res ?? c.body(null, 204);
    });

    // Stateless server: there is no session to attach a standalone SSE stream to
    // (GET) or to terminate (DELETE), so 405 is the correct Streamable-HTTP
    // response — matching the reference SDK's stateless behavior. (@hono/mcp's
    // own transport would instead open a hanging SSE stream on a stateless GET,
    // so we answer these methods ourselves rather than routing them through it.)
    app.on(["GET", "DELETE"], path, (c) =>
      c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method Not Allowed" },
          id: null,
        },
        405,
        { Allow: "POST" },
      ),
    );
  };
}
