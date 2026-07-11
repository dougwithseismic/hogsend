# @hogsend/mcp

A distributable [Model Context Protocol](https://modelcontextprotocol.io) server
for [Hogsend](https://hogsend.com). It exposes an agent-facing surface over your
Hogsend instance's admin API:

- **`manage_blueprint`** — author and operate Journey Blueprints (create /
  update / validate / enable / disable) as JSON graphs, no deploy in the loop.
- **`hogsend_report`** — a read-only health report (setup readiness, dead
  triggers, funnel drop-off, deliverability) with severity-ranked findings.
- **`send_test_email`** — send one real test email of a registered template.
- Resource **`hogsend://blueprint-authoring-guide`** — the full blueprint graph
  vocabulary, loaded on demand.
- Prompt **`find_and_fix_bottleneck`** — a safe report → propose-a-draft-fix →
  wait-for-approval workflow.

Full docs: **<https://hogsend.com/docs/integrations/mcp>**.

## Install & configure (Claude Desktop / Cursor)

The server runs over stdio via `npx` — nothing to install. Add it to your
client's MCP config.

**Claude Desktop** — `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "hogsend": {
      "command": "npx",
      "args": ["-y", "@hogsend/mcp"],
      "env": {
        "HOGSEND_API_URL": "https://api.your-instance.com",
        "HOGSEND_ADMIN_KEY": "hsk_your_admin_key"
      }
    }
  }
}
```

**Cursor** — the same shape in `~/.cursor/mcp.json` (global) or
`.cursor/mcp.json` (per-project):

```json
{
  "mcpServers": {
    "hogsend": {
      "command": "npx",
      "args": ["-y", "@hogsend/mcp"],
      "env": {
        "HOGSEND_API_URL": "https://api.your-instance.com",
        "HOGSEND_ADMIN_KEY": "hsk_your_admin_key"
      }
    }
  }
}
```

- `HOGSEND_API_URL` — base URL of your Hogsend API (default
  `http://localhost:3002`). Override per-run with `--url <baseUrl>`.
- `HOGSEND_ADMIN_KEY` — a **`full-admin`-scoped** admin API key (`ADMIN_API_KEY`
  is also accepted). Override per-run with `--admin-key <key>`. The key rides the
  `Authorization` header only — it is never placed in a URL.

**All tools require a `full-admin`-scoped key.** Hogsend's admin API authorizes
every bearer call at that scope, so a lesser "read"-scoped key is rejected with
403 on every route — even `hogsend_report`, which is read-only in *effect*. The
key is not.

> The admin key grants full control of your instance. Treat the MCP config as a
> secret, and never expose the key via a query parameter.

## Hosted transport (claude.ai connectors)

For a remote client, a Hogsend consumer app mounts the Streamable HTTP transport
by passing `mcpRoutes()` to `createApp`'s `routes` option:

```ts
import { createApp, createHogsendClient } from "@hogsend/engine";
import { mcpRoutes } from "@hogsend/mcp";

const app = createApp(createHogsendClient({ journeys, email: { templates } }), {
  routes: [mcpRoutes()],
  webhookSources,
});
```

That serves the server over Streamable HTTP at `POST /v1/mcp`, admin-gated by the
engine's `requireAdmin` and stateless (a fresh server per request; `GET`/`DELETE`
return `405`). Connect from a claude.ai custom connector with a static
`Authorization: Bearer <admin key>` header.

Because `@hogsend/mcp` ships raw `src/*.ts`, a consumer that bundles with tsup
**must** (1) add `@hogsend/mcp` to its `tsup` `noExternal` array so it gets
bundled, and (2) install `@hono/mcp` + `@modelcontextprotocol/sdk` as its own
runtime deps (they stay external when `@hogsend/mcp` is bundled):

```bash
pnpm add @hono/mcp @modelcontextprotocol/sdk
```

See the [docs](https://hogsend.com/docs/integrations/mcp) for the full
walkthrough and security notes.
