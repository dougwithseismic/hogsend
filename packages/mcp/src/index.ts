// @hogsend/mcp — a distributable MCP server for Hogsend. Library entry (raw
// `src/*.ts`, like @hogsend/engine). The `hogsend-mcp` stdio bin lives in
// ./bin.ts (built to dist/ by tsup).
//
// Surfaced for real consumers (e.g. the Phase 3 hosted route): the server
// factory + its options, the fetch AdminClient + its config/error types, the
// result/finding types callers narrow on, and `mcpRoutes` — the consumer-facing
// hosted transport. Everything else (tool factories, the SDK-wiring helpers,
// error mappers) is internal and imported via relative paths.
//
// IMPORTANT: `mcpRoutes` (and thus this barrel) pulls in `@hogsend/engine` and
// `@hono/mcp`. The stdio `bin.ts` MUST NOT import from this barrel — it wires
// itself from `./server.js` + `./lib/admin-client.js` directly so the published
// bin never drags the engine graph in.

export {
  type AdminClient,
  createFetchAdminClient,
  type FetchAdminClientConfig,
  type HttpError,
} from "./lib/admin-client.js";
export type { Finding, Severity } from "./lib/findings.js";
export type {
  HttpFailure,
  InvalidInputFailure,
  ToolFailure,
  ToolIssue,
} from "./lib/result.js";
export { type McpRoutesOptions, mcpRoutes } from "./routes.js";
export {
  type CreateHogsendMcpServerOptions,
  createHogsendMcpServer,
} from "./server.js";
