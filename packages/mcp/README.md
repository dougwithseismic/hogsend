# @hogsend/mcp

Talk to your Hogsend instance from Claude: *"find the bottlenecks in my funnel"*, *"make a journey for users stuck at activation"*, *"why did opens drop?"*.

An MCP (Model Context Protocol) server exposing a deliberately tiny, outcome-oriented tool surface over the Hogsend admin API. Reads are instant; writes create **disabled** artifacts that only go live through an explicit, reversible enable step.

## Tools

| Tool | What it does |
|---|---|
| `hogsend_report` | Every read in one call. Scopes: `health` (ranked bottleneck/deliverability findings — the default), `journey` (walkthrough + funnel + where users are parked), `template` (preview + engagement), `contact` (profile + timeline), `catalog` (journey ids + template keys). |
| `manage_journey` | The whole journey lifecycle: `create` (born disabled), `update`, `enable` (the explicit go-live gate), `disable`, `rollback`, `eject` (to TypeScript), `test` (enroll a test user). |
| `send_test_email` | One template to one explicit address — the only tool that emails a real inbox. |

## Connect from Claude Code

```bash
claude mcp add hogsend --env HOGSEND_API_URL=http://localhost:3002 --env HOGSEND_ADMIN_KEY=hsk_... -- npx @hogsend/mcp
```

Or with the Hogsend CLI installed: `claude mcp add hogsend -- hogsend mcp`

## Connect from Claude Desktop

```json
{
  "mcpServers": {
    "hogsend": {
      "command": "npx",
      "args": ["-y", "@hogsend/mcp"],
      "env": {
        "HOGSEND_API_URL": "https://your-instance.example.com",
        "HOGSEND_ADMIN_KEY": "hsk_..."
      }
    }
  }
}
```

## Configuration

| Env | Meaning |
|---|---|
| `HOGSEND_API_URL` | Instance origin (default `http://localhost:3002`) |
| `HOGSEND_ADMIN_KEY` | A `full-admin` API key — mint a dedicated one named `claude-mcp` so audit rows attribute cleanly |
| `HOGSEND_MCP_MODE` | `write` (default) or `read` — read registers only `hogsend_report` |

Every action the MCP takes is an ordinary admin API call: audited, rate-limited, attributable to the key.
