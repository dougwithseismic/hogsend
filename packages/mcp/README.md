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

## Install & configure (Claude Desktop / Cursor)

The server runs over stdio via `npx`. Add it to your client's MCP config, e.g.
`claude_desktop_config.json`:

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
