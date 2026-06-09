---
name: hogsend-cli
description: Use when an agent needs to inspect or operate a running Hogsend lifecycle engine — querying metrics/contacts/events, listing or enabling/disabling journeys, checking health, or onboarding a local instance — by driving the consolidated `hogsend` CLI. Every data command supports --json for machine-readable output.
license: MIT
metadata:
  author: withSeismic
  version: "1.3.0"
---

# Hogsend CLI

The `hogsend` CLI is the agent-native interface to a Hogsend app (the
code-first lifecycle orchestration engine on PostHog + Resend). It wraps the
app's `/v1/admin/*` and `/v1/health` HTTP routes, so it works against ANY
running instance — local (`http://localhost:3002`) or production — without
importing the database.

## The --json contract (READ THIS FIRST)

Every data command — read AND write — takes a global `--json` flag. In `--json`
mode the command prints EXACTLY ONE valid JSON document to stdout and nothing
else — no spinners, no color, no prose. **Always pass `--json` when you are
parsing the output programmatically.** Without it, you get a human-pretty
table/keyvalue rendering meant for a terminal (a write still confirms what it
did — the server's result body, e.g. `{ id, created, linked }`).

```bash
hogsend stats --json
hogsend journeys list --json
hogsend contacts get user_123 --json
hogsend events send signup --user-id user_123 --json
```

On error in `--json` mode the CLI prints `{"error":"<message>"}` to stdout and
exits 1. On success it exits 0 (doctor is the exception — see below).

## Connecting to an instance

Global flags / env vars control which instance you talk to and with which key.
The CLI carries TWO key kinds because it spans two HTTP planes:

- **Base URL:** `--url <baseUrl>` > `HOGSEND_API_URL` env > `.env`
  `HOGSEND_API_URL` > default `http://localhost:3002`.
- **Admin key** (the `/v1/admin/*` read commands): `--admin-key <key>` >
  `HOGSEND_ADMIN_KEY` env > `ADMIN_API_KEY` env > the `.env` equivalents. Sent as
  `Authorization: Bearer <key>`.
- **Data key** (the data-plane WRITE commands — `contacts upsert`,
  `events send`, `emails send`): `--data-key <key>` > `HOGSEND_DATA_KEY` env >
  `HOGSEND_API_KEY` env > the `.env` equivalents. This is an `ingest`-scoped key
  (a fresh scaffold mints `HOGSEND_API_KEY` as one). Its precedence is
  INDEPENDENT of the admin key — but since `full-admin` implies `ingest`, an
  admin key also works as the data key if no dedicated data key is set.

```bash
hogsend stats --url https://api.example.com --admin-key "$ADMIN_API_KEY" --json
hogsend events send signup --user-id u_1 --data-key "$HOGSEND_API_KEY" --json
```

`doctor` hits the unauthenticated `/v1/health` and needs no key. Read commands
require the admin key; the data-plane write commands require the data key.

## Command map

Most commands READ (admin API). A handful WRITE through the data plane — marked
**(write)** and using the **data key**, not the admin key.

| Command | Purpose |
|---------|---------|
| `hogsend doctor` | Health + schema-drift verdict (reachability check). |
| `hogsend stats` | Overview metrics (contacts, emails, bounce/unsub rates). |
| `hogsend journeys list/get/enable/disable` | Inspect + toggle journeys (enable/disable is a write to the admin API). |
| `hogsend contacts list/get/timeline` | Inspect contacts + their activity (read). |
| `hogsend contacts upsert` | **(write)** Create/update a contact → `PUT /v1/contacts`. `--email`/`--user-id` (≥1 required), `--prop key=value`/`--props <json>`, `--list <id>`/`--unlist <id>`. |
| `hogsend events <userId>` | Raw event stream for one user (READ — `<userId>` stays the read path). |
| `hogsend events send <name>` | **(write)** Push an event → `POST /v1/events`. `--email`/`--user-id` (≥1 required), `--prop`/`--props` (event props), `--contact-prop`/`--contact-props` (contact props), `--list`/`--unlist`, `--idempotency-key`, `--timestamp`. |
| `hogsend emails send <template>` | **(write)** Send a transactional email → `POST /v1/emails`. `--to`/`--user-id` (≥1 required), `--prop`/`--props`, `--subject`, `--from`, `--reply-to`, `--category`, `--idempotency-key`, `--skip-preference-check` (needs full-admin). |
| `hogsend webhooks list/get/create/update/delete/rotate-secret/test` | Manage **outbound** signed webhook endpoints (the event stream Hogsend emits to your URLs) → `/v1/admin/webhooks`. Needs the **admin key**, not the data key. `create --url <url>` + repeatable `--event <type>` or `--all-events`; the signing secret prints ONCE on `create` + `rotate-secret`. |
| `hogsend studio` | Serve the bundled Studio admin SPA locally (optionally against a remote `--base-url`). |
| `hogsend studio admin create/reset/list` | **Shell-gated** Studio admin create + recovery — DB-DIRECT, not HTTP. Gated by holding `DATABASE_URL` + `BETTER_AUTH_SECRET` (read from the ENVIRONMENT, not a `.env` file); writes passwords via Better Auth (scrypt, internal adapter), never raw SQL. Public sign-up is disabled, so this CLI (and the `STUDIO_ADMIN_EMAIL` boot bootstrap) are the ONLY ways to mint an admin. `create` bootstraps the first admin, `reset --email <e>` rotates a forgotten password (revokes sessions unless `--no-revoke`), `list` shows admins (no secrets). |
| `hogsend skills list/add` | Manage these bundled agent skills. |
| `hogsend upgrade` | Bump `@hogsend/*` deps to latest + refresh vendored skills. |
| `hogsend setup` | Interactive LOCAL onboarding (docker, secret, migrate). |
| `hogsend eject <pkg>` | Vendor a `@hogsend/*` package (unchanged). |
| `hogsend patch <pkg>` | Wrap `pnpm patch` (unchanged). |

`events <userId>` is the READ path; `events send` is its WRITE subcommand —
they share the `events` command but split on the first positional (`send`). The
write commands map 1:1 onto the `@hogsend/client` data-plane resources (see the
hogsend-client-sdk skill); the `--prop` vs `--contact-prop` split on
`events send` mirrors the SDK's `eventProperties` vs `contactProperties`.

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
3. Most commands READ, but `contacts upsert`, `events send`, `emails send` (and
   `journeys enable/disable`) WRITE — confirm intent before running them, and
   make sure a data key resolves (`--data-key` > `HOGSEND_DATA_KEY` >
   `HOGSEND_API_KEY`) for the data-plane writes.
4. Use `--limit`/`--offset` for pagination instead of dumping everything.
5. `studio admin` is the ONE family that does NOT use the HTTP API — it talks to
   the database directly and is gated by `DATABASE_URL` + `BETTER_AUTH_SECRET`
   (no `--url`/`--admin-key`). It's admin create/recovery, not data ops — prefer
   the masked password prompt over `--password` (which can leak into shell
   history). Those two vars are read from the ENVIRONMENT only (NOT a `.env`
   file), so run it with env loaded: locally `pnpm studio:admin` (the scaffold's
   `node --env-file=.env … hogsend studio admin create` wrapper) or
   `dotenvx run -- hogsend studio admin create`; on Railway `railway run hogsend
   studio admin create` (or `railway ssh`).

## First admin & closed sign-up

Public sign-up is DISABLED at the auth layer (`disableSignUp`) — `POST
/api/auth/sign-up/email` returns `400 EMAIL_PASSWORD_SIGN_UP_DISABLED` for
everyone, so there is NO unauthenticated network path that creates a user. The
first Studio admin is minted in one of two ways, both in-network:

- **CLI:** `hogsend studio admin create` (or the scaffold's `pnpm studio:admin`),
  gated by `DATABASE_URL` + `BETTER_AUTH_SECRET`. The only explicit path.
- **Env bootstrap:** set `STUDIO_ADMIN_EMAIL` (+ optional `STUDIO_ADMIN_PASSWORD`)
  in the deploy env. On boot, IF the user table is empty, the API mints that
  admin (idempotent, race-safe). With no password set, a strong one is
  auto-generated and printed ONCE to the server log — rotate it via the Studio
  forgot/reset flow. Once an admin exists it never re-mints.

If you (an agent) need an admin on a fresh instance and have shell access to the
DB + secret, `studio admin create` is the move; otherwise tell the operator to
set `STUDIO_ADMIN_EMAIL` and restart. There is no web "create admin" form to
drive. Login + forgot/reset stay fully enabled over HTTP.
