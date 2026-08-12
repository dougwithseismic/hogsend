# my-first-hogsend

A [Hogsend](https://hogsend.com) lifecycle orchestration app — code-first email
journeys on PostHog + Resend, powered by `@hogsend/engine` (pinned at
`0.63.0`). The engine is a versioned dependency; **your content**
(journeys, email templates, webhook sources, workflows, schema) lives in `src/`
and is yours to edit.

## Prerequisites

- Node 22 (`.node-version`)
- pnpm
- Docker (for local Timescale + Redis + Hatchet-Lite)

## Quickstart

```bash
pnpm install
pnpm bootstrap     # one command: Docker + .env + Hatchet token + migrate
pnpm dev           # HTTP API on http://localhost:3002
pnpm worker:dev    # Hatchet worker (run in a second terminal)
```

> **Reading this inside the Hogsend monorepo? Copy the folder out first.**
> This directory is deliberately not a pnpm workspace member — that is what
> keeps it an honest consumer of published packages — so a bare `pnpm install`
> here walks up, finds the repo's root `pnpm-workspace.yaml` and installs the
> *monorepo* instead, leaving this folder with no `node_modules`.
>
> `--ignore-workspace` is NOT the answer, though it looks like it: the flag that
> stops pnpm walking up also throws away **this** folder's own
> `pnpm-workspace.yaml` — every setting in it.
>
> - `allowBuilds` goes, so the install hard-fails with
>   `ERR_PNPM_IGNORED_BUILDS` (measured: exit 1).
> - `overrides` goes too. That one is currently harmless *only* because
>   `@hono/zod-openapi` is also pinned exactly in `package.json`, and pnpm
>   dedupes the engine's caret onto that pin — measured: still `1.4.0`, still
>   0 errors. The override is the belt to that pin's braces, and it matters the
>   day the direct dependency is removed (this app never imports the package;
>   it is declared only so tsup treats it as external, so a dead-dependency
>   sweep will offer to drop it). With the dep gone and no override, resolution
>   floats to the broken `1.5.2` and you get 33 errors inside `node_modules`.
>
> `--allow-build` does not exist in pnpm 11. `--ignore-scripts` silences the
> build failure and exits 0, but it is silencing a symptom rather than fixing
> the setup, and it leaves you one dead-dependency sweep away from the silent
> case above.
>
> So: `cp -R my-first-hogsend ~/somewhere && cd ~/somewhere && pnpm install`.
> Verified from a clean state — install, `check-types` and `build` all exit 0.
> That is also what you would do anyway; nobody develops their app inside
> somebody else's monorepo.

`pnpm bootstrap` is idempotent — re-run it any time. It creates `.env` (with a
fresh `BETTER_AUTH_SECRET`), brings up Timescale + Redis + Hatchet-Lite
(auto-remapping any host ports already in use, so multiple stacks coexist),
mints a Hatchet token for you, and runs both migration tracks. Set
`RESEND_API_KEY` in `.env` before sending real email.

API docs: `http://localhost:3002/docs`. Health: `GET /v1/health`.

## Verify the pipeline (end-to-end smoke)

The data plane requires an API key. On its **first** boot against an empty
database the API mints an ingest-scoped key and prints it once — grep the
`pnpm dev` output for `[api-keys]`:

```
[api-keys] First-boot ingest API key (shown once — save it now): hsk_…
```

Save it, then with `pnpm dev` + `pnpm worker:dev` running:

```bash
curl -XPOST http://localhost:3002/v1/events \
  -H "Authorization: Bearer $HOGSEND_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"name":"test.signup","userId":"smoke-1","email":"smoke@example.com"}'
```

```json
{ "stored": true, "exits": [], "contactKey": "smoke-1" }
```

`202` means the event was stored and pushed to Hatchet. The bundled
`test-onboarding` journey then runs to completion (no email / external deps).
Watch it in the Hatchet dashboard, or query `journey_states`:

```sql
SELECT journey_id, user_id, status FROM journey_states ORDER BY created_at DESC;
-- test-onboarding | smoke-1 | completed
```

`GET /v1/health` should report `schema.engine.inSync:true` and
`schema.client.inSync:true`.

Lost the key, or booted before this example wired the bootstrap? Mint another
with `POST /v1/admin/api-keys`, or clear the table (`DELETE FROM api_keys`) and
restart the API.

## Dev loop

- `pnpm dev` — API with hot reload (tsx watch)
- `pnpm worker:dev` — worker with hot reload
- `pnpm test` — vitest (this example ships no tests yet; the config and env are
  wired, so a `src/**/*.test.ts` file runs immediately. For deterministic
  journey tests see `@hogsend/testing`.)
- `pnpm check-types` — tsc
- `pnpm build` — tsup bundle to `dist/` (`pnpm start` / `pnpm worker` run it)

## Adding a journey

1. Create `src/journeys/my-journey.ts` using `defineJourney` (copy
   `src/journeys/welcome.ts` as a starting point).
2. Add any new event/template names to `src/journeys/constants/index.ts`.
3. Register it in `src/journeys/index.ts` (`journeys` array).

The journey's `trigger.event` is what enrolls a user; the engine routes
ingested events to matching journeys automatically.

## Adding a webhook source

1. Create `src/webhook-sources/my-source.ts` using `defineWebhookSource`
   (copy `src/webhook-sources/posthog.ts`).
2. Register it in `src/webhook-sources/index.ts`.

It is served at `POST /v1/webhooks/:sourceId`; the `transform` result feeds the
same ingestion pipeline that drives journeys.

## Customizing emails

Your email templates live in `src/emails/` — they're **yours**, edit freely. The
engine ships no business templates; it owns only the rendering machinery and the
delivery provider.

1. Edit or add a React Email component in `src/emails/` (copy `welcome.tsx`).
2. Add its prop type in `src/emails/types.ts`.
3. Register it in `src/emails/registry.ts` (key → component + subject + category).
4. Declare the key + props in `src/emails/templates.d.ts` so
   `sendEmail({ template, props })` is type-checked.

The `templates` registry is passed to `createHogsendClient({ email: { templates } })` and
threaded into the engine's tracked mailer (rendering, preferences, link/open
tracking, and the `email_sends` pipeline all come along for free). The template
keys line up with the `Templates` constants journeys send with.

## Adding a custom Hatchet task

1. Create a task in `src/workflows/` (copy `backfill-example.ts`).
2. Add it to the `extraWorkflows` array in `src/workflows/index.ts`.

`src/worker.ts` passes `extraWorkflows` to `createWorker`, so your tasks register
on worker start alongside the engine's built-ins.

## Swapping the email provider

The default email provider is Resend (built from `RESEND_API_KEY` /
`RESEND_WEBHOOK_SECRET`). To use Postmark, SES, etc., implement the engine's
`EmailProvider` contract (`import type { EmailProvider } from "@hogsend/engine"`)
— `send(msg)` + webhook parse/verify — and pass it as
`createHogsendClient({ email: { provider } })`. Rendering, tracking, preferences, and the
`email_sends` pipeline are engine-owned and unaffected by the swap.

## Migrations — two tracks

Hogsend uses **two independent migration tracks**:

- **Engine track** — owned by `@hogsend/db`, ledger
  `drizzle.__drizzle_migrations`. Applied first. You never author these; they
  arrive when you bump `@hogsend/*`.
- **Client track** — owned by this repo, ledger `drizzle.__client_migrations`,
  files in `./migrations`. Your own tables live in `src/schema/index.ts`.

```bash
pnpm db:generate    # generate a CLIENT migration from src/schema changes
pnpm db:migrate     # apply engine track, then client track (scripts/migrate.ts)
```

`scripts/migrate.ts` always runs engine-then-client. The Railway
`preDeployCommand` (`pnpm db:migrate`) does the same before each deploy.

> **`db:push` ledger gotcha:** `pnpm db:push` writes schema objects directly
> WITHOUT recording a row in the migration ledger. Convenient for fast local
> iteration, but it leaves the ledger *behind* the actual schema, so a later
> `db:migrate` (or the boot guard) thinks migrations are pending. For anything
> you intend to deploy, use `db:generate` + `db:migrate`, not `db:push`.

## Upgrading the engine

```bash
pnpm up "@hogsend/*"      # bump engine + plugins to the next pinned line
pnpm db:migrate           # apply any new engine migrations
pnpm build && node dist/index.js   # prove the BUNDLE boots, not just tsc
# then confirm: GET /v1/health shows engine + client both inSync:true
```

> **Mirror the engine's new npm dependencies.** `tsup` treats anything absent
> from this `package.json` as bundleable, so a dependency the engine picked up
> since your last upgrade gets inlined into `dist/`. For a CommonJS package that
> fails at runtime, not at build time:
> `Error: Dynamic require of "path" is not supported`. `pnpm check-types` and
> `pnpm build` both pass; only `node dist/index.js` catches it. After an
> upgrade, diff `@hogsend/engine`'s `dependencies` against this file and add
> anything missing (that is what keeps `ai`, `svix`, `qrcode`, `picocolors`,
> `acorn`, `launch-editor` and `@openrouter/ai-sdk-provider` listed below —
> this app imports none of them directly).

The boot guard in `src/index.ts` refuses to start if the **engine** schema is
behind the build (a behind-engine DB is a fatal misconfiguration). The
**client** track does not gate boot — a pending client migration surfaces as
`status:"migration_pending"` on `/v1/health` for you to resolve.
