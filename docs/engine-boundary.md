# Engine ⇄ Client Boundary

> The contract for the `@hogsend/engine` carve (Phase 1 of
> `docs/TODO-packages-migration.md`). The engine ships the **framework**; the
> client repo (`apps/api` today; a scaffolded app tomorrow) owns the **content**.
> Content is registered by **client app code** passed into engine factories —
> never by editing a shared engine index. That is what eliminates the
> merge-conflict surface (`journeys/index.ts`, `webhook-sources/index.ts`).

## Locked decisions (D1–D6)

These were the open decisions in the TODO; locked to the recommended defaults to
reach the first usable release (Phases 1–4) fastest. Revisit D1/D5/D6 post-1.0.

| # | Decision | Locked choice |
| --- | --- | --- |
| D1 | Built-in journeys/sources placement | **Scaffolded into the client repo as editable starter code.** `welcome.ts`, the PostHog source, and constants are CONTENT, copied in by `create-hogsend`, not published. |
| D2 | Engine public API surface | **Injection points** on `createHogsendClient`, `createApp`, `createWorker` (signatures below), plus `defineJourney` / `defineWebhookSource`. This is the committed semver surface. |
| D3 | Auth ownership | **Engine builds auth inside `createHogsendClient`** from `lib/auth.ts` (better-auth) using env; client configures via env and may override via container overrides. (There is no separate `@hogsend/auth` package — auth lives in `apps/api/src/lib/auth.ts` and moves into the engine with the rest of `lib/`.) |
| D4 | Client-migration ledger | **`drizzle.__client_migrations` in the same DB** (engine track stays `drizzle.__drizzle_migrations`). Phase 2. |
| D5 | Engine package granularity | **Single `@hogsend/engine`** package. One upgrade unit, one public surface. |
| D6 | `create-hogsend` v1 scope | **App-only scaffold.** Railway one-click template deferred. |

## Per-file classification (`apps/api/src`)

FRAMEWORK → moves to `packages/engine/src`. CONTENT → stays in `apps/api/src`
(and becomes the `create-hogsend` template).

| Path | Class | Reason |
| --- | --- | --- |
| `container.ts` | FRAMEWORK | DI container factory (gains `journeys` injection seam) |
| `container.ts` / `app.ts` | FRAMEWORK | `HogsendClient`, `AppEnv` type contracts |
| `app.ts` | FRAMEWORK | Hono app factory + middleware stack |
| `env.ts` | FRAMEWORK | t3-env base schema (client may extend) |
| `db.ts` | FRAMEWORK | re-exports `@hogsend/db` schema/drizzle |
| `lib/logger.ts` | FRAMEWORK | Pino logger factory |
| `lib/email.ts` | FRAMEWORK | `sendEmail()` service wrapper |
| `lib/hatchet.ts` | FRAMEWORK | Hatchet client singleton |
| `lib/ingestion.ts` | FRAMEWORK | `ingestEvent()` central pipeline |
| `lib/posthog.ts` | FRAMEWORK | `getPostHog()` singleton |
| `lib/tracking.ts` | FRAMEWORK | `prepareTrackedHtml()` |
| `lib/tracking-events.ts` | FRAMEWORK | tracking event helpers |
| `lib/backfill.ts` | FRAMEWORK | `runBatchedBackfill()` |
| `journeys/define-journey.ts` | FRAMEWORK | `defineJourney()` factory |
| `journeys/journey-context.ts` | FRAMEWORK | `JourneyContext` primitives |
| `routes/index.ts` | FRAMEWORK | `registerRoutes()` |
| `routes/health.ts` | FRAMEWORK | health + schema-version endpoint |
| `routes/ingest.ts` | FRAMEWORK | ingest endpoint |
| `routes/email/*` | FRAMEWORK | unsubscribe / preferences |
| `routes/admin/*` | FRAMEWORK | contacts / preferences admin |
| `routes/tracking/*` | FRAMEWORK | click / open tracking |
| `routes/webhooks/resend.ts` | FRAMEWORK | Resend webhook |
| `routes/webhooks/sources.ts` | FRAMEWORK | iterates **injected** sources |
| `workflows/send-email.ts` | FRAMEWORK | `sendEmailTask` Resend delivery |
| --- | --- | --- |
| `index.ts` | CONTENT | thin HTTP entry (container→app→serve + boot guard) |
| `worker.ts` | CONTENT | thin worker entry (registers tasks) |
| `journeys/index.ts` | CONTENT | `allJourneys[]` + registry wiring (merge surface — eliminated) |
| `journeys/welcome.ts` | CONTENT | example journey |
| `journeys/constants/*` | CONTENT | `Events` / `Templates` literals for client journeys |
| `webhook-sources/index.ts` | CONTENT | `allSources[]` wiring (merge surface — eliminated) |
| `webhook-sources/posthog.ts` | CONTENT | example webhook source |
| `webhook-sources/define-webhook-source.ts` | FRAMEWORK | `defineWebhookSource()` factory |
| `workflows/backfill-example.ts` | CONTENT | example backfill job template |
| `workflows/index.ts` | CONTENT | client workflow aggregation |

## Engine public API (the injection seams)

The shared-index aggregation (`allJourneys`, `allSources`, `getJourneyTasks`) is
**deleted from the engine**. Content is passed in:

```ts
// @hogsend/engine
createHogsendClient(opts?: {
  journeys?: Journey[];                 // → builds JourneyRegistry from these
  templates?: TemplateRegistry;        // client's src/emails registry (Move 1)
  provider?: EmailProvider;               // swappable email provider (Move 2)
  analytics?: PostHogService;          // default: PostHog from env
  enabledJourneys?: string;
  clientJournal?: JournalShape;
  overrides?: {                        // advanced / test-only (Move 3)
    mailer?: EmailService;
    auth?: Auth;
    hatchet?: HatchetClient;
    db?: Database;
  };
}): HogsendClient;

createApp(container: HogsendClient, opts?: {
  routes?: (app: OpenAPIHono<AppEnv>) => void;  // mount custom routers
  middleware?: MiddlewareHandler[];
  webhookSources?: WebhookSource[];             // served at /v1/webhooks/:sourceId
  onError?: ErrorHandler;
}): OpenAPIHono<AppEnv>;

createWorker(opts: {
  container: HogsendClient;
  journeys: Journey[];                  // journey durable tasks
  extraWorkflows?: unknown[];           // extra client tasks beyond built-ins
}): { start(): Promise<void>; stop(): Promise<void> };
```

Client app code (the dogfood `apps/api`, and every scaffolded app) becomes:

```ts
// src/index.ts (CONTENT)
import { createHogsendClient, createApp, getSchemaVersion } from "@hogsend/engine";
import { journeys } from "./journeys/index.js";       // THEIR journeys
import { webhookSources } from "./webhook-sources/index.js";

const container = createHogsendClient({ journeys });
// ...boot guard via getSchemaVersion(container.db)...
const app = createApp(container, { webhookSources });
serve({ fetch: app.fetch, port: container.env.PORT });
```

```ts
// src/worker.ts (CONTENT)
import { createWorker } from "@hogsend/engine";
import { journeys } from "./journeys/index.js";
const worker = createWorker({ container: createHogsendClient({ journeys }), journeys });
await worker.start();
```

## Boundary invariants (enforced by review + import direction)

1. **Content imports engine; engine never imports content.** No `@hogsend/engine`
   file may import from `apps/api/src`. Spot-check by grepping the engine package
   for any relative path that escapes the package.
2. **No shared mutable registry in the engine.** `JourneyRegistry` is *constructed*
   in the engine but *populated* from injected `journeys`.
3. **Preserve both `email` and `emailService`** keys on `HogsendClient` (existing
   code uses both; `emailService` is the engine-built `TrackedMailer`).
4. **One drizzle instance.** `container.db` is the single source; `db.ts`
   re-export must not spawn a second client.
5. **`.js` extensions** on all relative ESM imports inside the engine package.
6. **Engine bundles `@hogsend/*` via tsup `noExternal`** (mirror current API build)
   so consumers resolve cleanly; runtime npm deps stay external.
