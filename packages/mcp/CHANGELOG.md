# @hogsend/mcp

## 0.42.0

### Minor Changes

- 57e6272: New `@hogsend/mcp` package — a distributable Model Context Protocol server for a running Hogsend instance.
  - New publishable `@hogsend/mcp` package with two transports over one tool implementation: **stdio** (`npx @hogsend/mcp`, for Claude Desktop / Cursor / any local client) and **Streamable HTTP** — a consumer-mounted route (`mcpRoutes()` passed to `createApp`'s `routes` option) served at `POST /v1/mcp` for claude.ai connectors. The hosted route is admin-gated by the engine's existing `requireAdmin` and runs each tool call in-process with the caller's own credential, so there is no new engine dep and no parallel auth path.
  - Surface: three tools (`manage_blueprint` — create/update/validate/enable/disable Journey Blueprints; `hogsend_report` — a read-only health report with severity-ranked findings across the health/blueprints/journeys/deliverability/catalog scopes; `send_test_email`), the `hogsend://blueprint-authoring-guide` resource, and the `find_and_fix_bottleneck` prompt.
  - Engine changes backing it: new `GET /v1/admin/api-keys/self` (returns the calling credential's identity) and `GET /v1/admin/events/names` read routes, `requireAdmin` exported from the engine barrel, the blueprint authoring-guide extracted into a shared env-free `@hogsend/engine/mcp/authoring-guide` export, blueprint `409` conflict bodies now carry a machine-readable `code`, and stricter `entryPeriod` / `within` schema validation.

### Patch Changes

- Updated dependencies [d7328a3]
- Updated dependencies [6e17712]
- Updated dependencies [01ac1f3]
- Updated dependencies [df76ac6]
- Updated dependencies [57e6272]
  - @hogsend/engine@0.42.0
