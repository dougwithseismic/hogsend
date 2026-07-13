---
"@hogsend/engine": minor
"@hogsend/mcp": patch
---

Restrict the template test-send route to verified operator/team addresses.

`POST /v1/admin/templates/{key}/send-test` (and the `@hogsend/mcp`
`send_test_email` tool that wraps it) is reachable only with a `full-admin`
key and sends with preference checks skipped. It previously accepted an
arbitrary `to`, so a prompt-injected agent driving the MCP server could deliver
a registered template — with attacker-controlled props — to any inbox,
including suppressed recipients. The recipient is now bounded in the route
handler — so it applies to the `send_test_email` tool and any other caller of
this route — to the admin team: a row in the `user` table, or
`HOGSEND_TEST_EMAIL` / `STUDIO_ADMIN_EMAIL`. Any other address returns `403`.
A test send can now only ever reach your own team, never an arbitrary recipient.
