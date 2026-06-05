# my-first-hogsend

A [Hogsend](https://hogsend.com) lifecycle orchestration app — code-first email
journeys on PostHog + Resend, powered by `@hogsend/engine` (pinned at
`0.0.1`). The engine is a versioned dependency; **your content**
(journeys, email templates, webhook sources, workflows, schema) lives in `src/`
and is yours to edit.

## Prerequisites

- Node 22 (`.node-version`)
- pnpm
- Docker (for local Timescale + Redis + Hatchet-Lite)

## Quickstart

```bash
pnpm bootstrap     # one command: Docker + .env + Hatchet token + migrate
pnpm dev           # HTTP API on http://localhost:3002
pnpm worker:dev    # Hatchet worker (run in a second terminal)
```

`pnpm bootstrap` is idempotent — re-run it any time. It creates `.env` (with a
fresh `BETTER_AUTH_SECRET`), brings up Timescale + Redis + Hatchet-Lite
(auto-remapping any host ports already in use, so multiple stacks coexist),
mints a Hatchet token for you, and runs both migration tracks. Set
`RESEND_API_KEY` in `.env` before sending real email.

API docs: `http://localhost:3002/docs`. Health: `GET /v1/health`.

## Verify the pipeline (end-to-end smoke)

With `pnpm dev` + `pnpm worker:dev` running:

```bash
curl -XPOST http://localhost:3002/v1/ingest \
  -H 'content-type: application/json' \
  -d '{"event":"test.signup","userId":"smoke-1","userEmail":"smoke@example.com"}'
```

The bundled `test-onboarding` journey runs to completion (no email / external
deps). Watch it in the Hatchet dashboard, or query `journey_states`.
`GET /v1/health` should report `schema.engine.inSync:true` and
`schema.client.inSync:true`.

## Dev loop

- `pnpm dev` — API with hot reload (tsx watch)
- `pnpm worker:dev` — worker with hot reload
- `pnpm test` — vitest
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
`EmailProvider` contract (`send(msg)` + webhook parse/verify) and pass it as
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
# then confirm: GET /v1/health shows engine + client both inSync:true
```

The boot guard in `src/index.ts` refuses to start if the **engine** schema is
behind the build (a behind-engine DB is a fatal misconfiguration). The
**client** track does not gate boot — a pending client migration surfaces as
`status:"migration_pending"` on `/v1/health` for you to resolve.
