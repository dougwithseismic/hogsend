---
name: hogsend-cli
description: Use when an agent needs to inspect or operate a running Hogsend lifecycle engine — querying metrics/contacts/events, listing or enabling/disabling journeys, checking health, or onboarding a local instance — by driving the consolidated `hogsend` CLI. Every data command supports --json for machine-readable output.
license: MIT
metadata:
  author: withSeismic
  version: "1.0.0"
---

# Hogsend CLI

The `hogsend` CLI is the agent-native interface to a Hogsend app (the
code-first lifecycle orchestration engine on PostHog + Resend). It wraps the
app's `/v1/admin/*` and `/v1/health` HTTP routes, so it works against ANY
running instance — local (`http://localhost:3002`) or production — without
importing the database.

## The --json contract (READ THIS FIRST)

Every data/read command takes a global `--json` flag. In `--json` mode the
command prints EXACTLY ONE valid JSON document to stdout and nothing else — no
spinners, no color, no prose. **Always pass `--json` when you are parsing the
output programmatically.** Without it, you get a human-pretty table/keyvalue
rendering meant for a terminal.

```bash
hogsend stats --json
hogsend journeys list --json
hogsend contacts get user_123 --json
```

On error in `--json` mode the CLI prints `{"error":"<message>"}` to stdout and
exits 1. On success it exits 0 (doctor is the exception — see below).

## Connecting to an instance

Two global flags / env vars control which instance you talk to:

- Base URL: `--url <baseUrl>` > `HOGSEND_API_URL` env > `.env` `HOGSEND_API_URL`
  > default `http://localhost:3002`.
- Admin key: `--admin-key <key>` > `HOGSEND_ADMIN_KEY` env > `ADMIN_API_KEY`
  env > the `.env` equivalents. Sent as `Authorization: Bearer <key>`.

```bash
hogsend stats --url https://api.example.com --admin-key "$ADMIN_API_KEY" --json
```

`doctor` hits the unauthenticated `/v1/health` and needs no admin key. Every
other data command requires one.

## Command map

| Command | Purpose |
|---------|---------|
| `hogsend doctor` | Health + schema-drift verdict (reachability check). |
| `hogsend stats` | Overview metrics (contacts, emails, bounce/unsub rates). |
| `hogsend journeys list/get/enable/disable` | Inspect + toggle journeys. |
| `hogsend contacts list/get/timeline` | Inspect contacts + their activity. |
| `hogsend events <userId>` | Raw event stream for one user. |
| `hogsend skills list/add` | Manage these bundled agent skills. |
| `hogsend setup` | Interactive LOCAL onboarding (docker, secret, migrate). |
| `hogsend eject <pkg>` | Vendor a `@hogsend/*` package (unchanged). |
| `hogsend patch <pkg>` | Wrap `pnpm patch` (unchanged). |

Run `hogsend <command> --help` for per-command usage.

## Task playbooks (load the matching reference)

- **Query metrics / analyse data** → `references/query-stats.md`
- **List, inspect, enable or disable journeys** → `references/manage-journeys.md`
- **Debug why a user did / didn't enroll** → `references/debug-a-journey.md`
- **Set up a local instance** → `references/setup-local.md`

## Golden rules for agents

1. Pass `--json` whenever you will parse output. Never screen-scrape the table.
2. Start a debugging session with `hogsend doctor --json` to confirm the
   instance is reachable and the schema is in sync before trusting other reads.
3. Enabling/disabling a journey is a write — confirm intent first.
4. Use `--limit`/`--offset` for pagination instead of dumping everything.
