# {{APP_NAME}}

A **Hogsend** app — code-first lifecycle orchestration on PostHog + Resend. This
project is a thin, **content-only** consumer of the `@hogsend/engine` framework
(pinned at `{{ENGINE_VERSION}}`). The engine is a versioned npm dependency you do
NOT edit here — you author *content* and wire it into the engine's factories.

## What you edit (the content surface)

| Directory | What lives there | Author with |
|-----------|------------------|-------------|
| `src/journeys/` | Lifecycle journeys | `defineJourney()` |
| `src/emails/` | React-email templates + registry | `.tsx` + `registry.ts` + `templates.d.ts` |
| `src/buckets/` | Real-time audience membership | `defineBucket()` |
| `src/webhook-sources/` | Inbound webhook ingestion | `defineWebhookSource()` |
| `src/workflows/` | Custom Hatchet tasks | `hatchet.task()` + `extraWorkflows` |
| `src/schema/` | Your own (client-track) DB tables | Drizzle `pgTable` |
| `src/journeys/constants/` | `Events` + `Templates` typed constants | `as const` |

Two entry points wire it together — `src/index.ts` (HTTP) and `src/worker.ts`
(task execution) — by calling `createHogsendClient`, `createApp`, and
`createWorker` from `@hogsend/engine`.

## THE WIRING RITUAL — the #1 "it compiled but nothing fires" bug

Authoring something is only half the job. Each new journey / bucket / webhook
source / workflow / template must ALSO be:

1. Exported from its `src/<area>/index.ts`, **and**
2. Threaded into the right factory — journeys & buckets into
   `createHogsendClient` (and `createWorker`), webhook sources into
   `createApp({ webhookSources })`, custom tasks into
   `createWorker({ extraWorkflows })` (the option is `extraWorkflows`, not
   `workflows`).

A new email template needs ALL FOUR of: the `.tsx` component, a `registry.ts`
entry, a `templates.d.ts` augmentation, and a matching `Templates` constant key.
Miss one and you get a type error or a silent no-send.

## House rules

- **Biome** for lint + format (2-space indent, double quotes, semicolons, 80
  cols). Run `pnpm lint:fix`.
- **Conventional Commits** (`feat`, `fix`, `docs`, `chore`, …).
- **ESM** — use `.js` extensions in relative imports. Node 22.
- Task input types must be JSON-serializable (no `[key: string]: unknown`).
- `ctx` inside a journey is durable-execution primitives only (`sleep`,
  `checkpoint`, `trigger`, `identify`, `guard`, `history`, `posthog`). Sending
  email or capturing analytics are STANDALONE imports (`sendEmail`, `getPostHog`
  from `@hogsend/engine`), not methods on `ctx`.

## Commands

```bash
pnpm dev            # HTTP API on :3002
pnpm worker:dev     # Hatchet worker (second terminal)
pnpm db:generate    # generate a migration from src/schema changes
pnpm db:migrate     # run migrations
pnpm test           # vitest
```

## Agent skills (deep, on-demand guidance)

Focused Claude Code skills live in `.claude/skills/` and Claude Code discovers
them automatically. Open the one that matches your task — depth lives in the
skills, not in this file:

| Task | Skill |
|------|-------|
| Add or edit a journey | `hogsend-authoring-journeys` |
| Add or edit an email (incl. tracking) | `hogsend-authoring-emails` |
| Real-time audience membership | `hogsend-authoring-buckets` |
| A `where` / `criteria` / `exitOn` clause | `hogsend-conditions` |
| Inbound webhook or custom task | `hogsend-webhooks-and-workflows` |
| Schema / migrations | `hogsend-database` |
| Deploy to Railway | `hogsend-deploy` |
| Inspect or operate a running app | `hogsend-cli` |

Install or refresh these any time with `hogsend skills add` (use
`hogsend skills add --force` after upgrading the engine).

Full product docs: docs.hogsend.com
