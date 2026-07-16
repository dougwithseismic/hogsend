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
| `src/destinations/` | Outbound event fan-out (PostHog/Segment/Slack/CRM) | `defineDestination()` |
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
   `createApp({ webhookSources })`, destinations into `createHogsendClient`
   (in BOTH `src/index.ts` AND `src/worker.ts`, NOT `createWorker`), custom
   tasks into `createWorker({ extraWorkflows })` (the option is `extraWorkflows`,
   not `workflows`).

A new email template needs ALL FOUR of: the `.tsx` component, a `registry.ts`
entry, a `templates.d.ts` augmentation, and a matching `Templates` constant key.
Miss one and you get a type error or a silent no-send.

After adding a journey, confirm its id appears in the worker's startup
`journeys: [...]` log line. Dev watchers can miss brand-new files — if the id
is missing, restart the worker (`pnpm worker:dev`) or events for it will
silently do nothing.

## House rules

- **Biome** for lint + format (2-space indent, double quotes, semicolons, 80
  cols). Run `pnpm lint:fix`.
- **Conventional Commits** (`feat`, `fix`, `docs`, `chore`, …).
- **ESM** — use `.js` extensions in relative imports. Node 22.
- Task input types must be JSON-serializable (no `[key: string]: unknown`).
- `ctx` inside a journey is durable-execution primitives only (`sleep`,
  `sleepUntil`, `when`, `waitForEvent`, `digest`, `once`, `checkpoint`,
  `trigger`, `guard`, `history`). Sending email or capturing analytics are
  STANDALONE imports (`sendEmail`, `getPostHog` from `@hogsend/engine`), not
  methods on `ctx` — there is no `ctx.identify` or `ctx.posthog`.

## Commands

```bash
pnpm hogsend dev    # daily driver: API + worker + health + URLs, one terminal
pnpm dev            # manual: HTTP API on :3002
pnpm worker:dev     # manual: Hatchet worker (second terminal)
pnpm db:generate    # generate a migration from src/schema changes
pnpm db:migrate     # run migrations
pnpm test           # vitest
```

## Zero to running (headless / agents)

Everything works without a TTY — no prompts, machine-readable outcomes:

- **Setup** (idempotent, safe to re-run): `pnpm bootstrap` — Docker infra,
  `.env`, port auto-remap, Hatchet token, migrations (engine track verified),
  and two keys into `.env`: `HOGSEND_API_KEY` (ingest) + `HOGSEND_ADMIN_KEY`
  (full-admin, what the `hogsend` CLI reads). Exit 0 = every step succeeded;
  exit 1 = the failed steps are re-listed in the summary. Non-TTY runs print
  the FULL cause under each failure (stderr tails, stack traces) — read it,
  don't guess; in a terminal, `HOGSEND_DEBUG=1` forces the same detail.
- **First admin** (sign-up is closed): set `STUDIO_ADMIN_EMAIL` (and optionally
  `STUDIO_ADMIN_PASSWORD`, min 8 chars) in `.env` — the API mints the admin on
  FIRST BOOT when the user table is empty. Without a password one is generated
  and printed ONCE: grep the boot log for `First admin created`. Fallback:
  `pnpm studio:admin` (supports `--email`/`--password`/`--json`). Scaffold-time:
  `create-hogsend --admin-email … [--admin-password …]` presets both.
- **Run + readiness**: start `pnpm dev` and `pnpm worker:dev` as background
  processes you manage, then poll `GET /v1/health` until `"status":"healthy"`.
  `migration_pending` ⇒ run `pnpm db:migrate`; `degraded` ⇒ serving, but check
  `components.{database,redis,worker}`. Non-TTY boots always emit the
  structured `"Hogsend API ready"` / `"Hogsend worker ready"` log lines.
  Worker liveness is `components.worker` on health (Redis heartbeat).
- **Operate with `--json`**: start with `pnpm hogsend doctor --json`; every
  data command supports `--json`. Keys resolve from `.env` automatically.
- **PostHog without a browser**: the OAuth `connect posthog` flow needs a human;
  headless, set `POSTHOG_PERSONAL_API_KEY` on the instance (person reads + loop
  provisioning work automatically), and `pnpm hogsend connect posthog
  --provision-only` re-wires the event loop from an already-stored credential.
- **Smoke the loop**: `pnpm hogsend events send test.event --email a@b.com
  --json`, then `pnpm hogsend contacts get a@b.com --json`.

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
| Outbound event fan-out (PostHog/Segment/Slack/CRM) | `hogsend-authoring-destinations` |
| Schema / migrations | `hogsend-database` |
| Deploy to Railway | `hogsend-deploy` |
| Inspect or operate a running app | `hogsend-cli` |

Install or refresh these any time with `hogsend skills add` (use
`hogsend skills add --force` after upgrading the engine).

Full product docs: docs.hogsend.com
