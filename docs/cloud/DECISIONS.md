# Hogsend Cloud — DECISIONS (locked)

Every PRD inherits this file. Settled choices are not re-litigated during BUILD.
Spec stack lives in `docs/cloud/` (`DECISIONS.md`, `BACKLOG.md`, `prds/`).

## 1. Product definition

Hogsend Cloud is a hosted control plane for the existing Hogsend engine. Customers sign up,
pick a plan and region, paste their own provider keys (Resend/Postmark, PostHog, optional
Twilio/Discord/Telegram), and get a running managed Hogsend instance. Local dev stays exactly
as today (create-hogsend scaffold); `hogsend login` + `hogsend publish` pushes their app to
their cloud instance. Customers never see the substrate — they see the dashboard, the CLI, an
ingest URL, and a tracking domain.

Structural advantages we state everywhere: BYO sending keys (deliverability reputation is the
customer's — we are not an ESP), per-tenant database isolation, eject-to-self-host any time
(same code).

## 2. Tiers, pricing, limits (locked 2026-07-28 with Doug)

| Tier | Price | Infra | Limits | Environments |
|---|---|---|---|---|
| Trial | free, 14 days | shared (rung 1) | 10k events + 1k emails total | 1 (prod) |
| Self-serve | $49/mo | shared (rung 1) | 100k events + 10k emails /mo | 2 (prod + 1) |
| Dedicated | $149/mo | private Postgres + private Hatchet (rung 0) | 1M events + 100k emails /mo | 4 |

- Dedicated additionally gets: custom tracking domain (`customDomainCreate`) and any-region
  choice always.
- **Shared infra is organized into region CELLS** (first-class `cells` rows: region, shared
  cluster DSN, shared Hatchet URL, `accepting` flag). Shared-tier orgs attach to a cell;
  the signup region picker offers exactly the regions with an accepting cell. Launch config:
  one US cell; adding EU self-serve later = provision an EU cell (~$30–60/mo fixed) and flip
  it `accepting` — an ops action, never a code change. A region with no accepting cell is
  selectable only with the dedicated plan.
- Overages **soft-block at ingest** (429 with clear error + dashboard banner), never data loss
  for already-accepted events. Mechanism: a small engine feature this wave —
  `HOGSEND_INGEST_SUSPENDED=true` makes `/v1/events` return 429 with a documented error body
  (PRD 06's boundary explicitly includes this `packages/engine` change), driven via
  `SubstrateProvider.setEnv` + redeploy. Suspension (non-payment/abuse) stops api+worker, keeps data.
- Existing service tiers (setup / DFY) are unchanged and out of scope here.

## 3. Architecture + repo layout

- **`apps/cloud`** — the control plane, in this monorepo. Next.js (App Router, dark-only,
  reusing the apps/docs design-system primitives — copy `components/ds` into `apps/cloud`,
  do NOT cross-import between apps). Two processes:
  - the Next.js server (UI + `/api` route handlers),
  - **`cloud-worker`** — a small Node entry hosting durable control-plane jobs (provision,
    build, health poll, metering, destroy) as **Hatchet tasks** using
    `@hatchet-dev/typescript-sdk` **directly** (NOT via `@hogsend/engine` — the engine's
    singletons are single-tenant by design and must not be imported by the control plane).
- **Cloud database** — its own Postgres (never the engine DB), own Drizzle schema +
  migrations under `apps/cloud/src/db/` with its own ledger. Local dev uses the existing
  docker-compose Postgres with a separate database `hogsend_cloud`.
- **Auth** — Better Auth with the organization plugin, **public sign-up ENABLED** (unlike the
  engine). Email/password + email OTP verify; social login deferred.
- **Tenant model** — `organization → environments (prod/staging/test) → stack` (exactly one
  stack per environment). All tenant-scoped tables carry `organizationId NOT NULL` with FK.
- **Substrate abstraction (THE seam)** — all infra operations go through a
  `SubstrateProvider` interface (`provisionStack`, `destroyStack`, `setEnv`, `redeploy`,
  `deployImage`, `attachDomain`, `getHealth`, `suspend`, `resume`). Two implementations:
  `FakeSubstrate` (deterministic, in-memory + fixture latency; used by all tests and local
  dev) and `RailwaySubstrate` (GraphQL v2 `backboard.railway.com/graphql/v2`, retry with
  backoff — `templateDeployV2` has known intermittent 400s). Business logic never imports
  Railway types.
- **Railway topology (rung 1)** — one **shared project per region cell** holds: shared
  Postgres cluster (tenant DBs created via SQL `CREATE DATABASE`/`CREATE ROLE`), shared
  Hatchet-Lite (pinned v0.84.0) + its Postgres. Launch = one US cell. One **Railway project per organization** holds that org's
  per-environment services: tiny Redis + `api` + `worker` per stack. Per-tenant Hatchet
  isolation via a per-stack Hatchet tenant + token (minted headlessly, the
  `hogsend hatchet token` flow) + `HATCHET_CLIENT_NAMESPACE=<stackId>`.
- **Dedicated tier (rung 0)** — same `SubstrateProvider` calls, different plan: private
  Postgres + private Hatchet services inside the org's project, region selectable
  (`us-west2` | `europe-west4`).
- **Publish pipeline** — `hogsend publish` tars the scaffold (gitignore-respecting, never
  `.env`), uploads with a manifest (engine version, entry points, env keys). Cloud build:
  generic scaffold **Dockerfile** (added to `packages/create-hogsend/template/`), built by
  the cloud-worker, image pushed to GHCR, deployed via `SubstrateProvider.deployImage`.
  Engine version is **locked at publish** (lockfile shipped in the tarball; no caret drift).
  Preflight gate (generalized `scripts/preflight-deploy.sh`) runs on every build before
  deploy.
- **CLI** — `hogsend login` (device-code flow against apps/cloud), credentials in
  `~/.hogsend/credentials.json` (0600), `hogsend publish [--env <name>]`, `hogsend open`.
  The legacy Go CLI in `cli/` is a **reference only** (its Railway GraphQL queries inform
  `RailwaySubstrate`); no Go code ships. Go CLI removal is a later cleanup, not this wave.

## 4. Quality gates (every task, verbatim)

```bash
pnpm exec turbo run check-types --concurrency=2
pnpm exec turbo run lint --concurrency=2
pnpm exec turbo run test --concurrency=2
pnpm exec turbo run build --concurrency=2
```

(`--concurrency=2` per the known turbo OOM issue.) Tests: vitest, colocated under
`apps/cloud/src/__tests__/`. TDD: failing test first for every behavioral task. Biome
formatting; conventional commits; 2-space/double-quote/semicolons per repo style.

## 5. Conventions

- One commit per task, conventional message, scope `cloud` (e.g. `feat(cloud): …`),
  `cli` for CLI tasks, `create-hogsend` for template tasks. No AI/vendor mentions, no
  co-author trailers.
- **Publish mode: local-commits-only** on branch `worktree-hogsend-cloud`. PR + squash-merge
  only at wave end with Doug's explicit nod (calm release discipline). Never push mid-wave.
- User-facing dashboard features ship behind simple env feature flags
  (`CLOUD_FEATURE_<NAME>`) when incomplete.
- Secrets: provider keys and substrate tokens encrypted at rest (AES-256-GCM, key derived
  from `CLOUD_ENCRYPTION_SECRET`); never logged; never in fixtures.
- No summary markdown docs; only BACKLOG markers + PRD Implementation Notes change in BUILD.

## 6. Design

Reuse the Hogsend brand: dark-only, the docs design-system primitives (`components/ds`
copied into `apps/cloud/components/ds`), crimzon accent, same type stack as apps/docs. No
new design language. Dashboard tone: dense, factual, operator-grade (Railway/Vercel
register, Hogsend voice — every line a fact).

## 7. Working-app essentials (must exist, may be stubbed)

Account settings, org management (members/invites/roles via Better Auth org plugin),
delete-account/data, Terms + Privacy pages (stub copy, routed + designed), API docs for the
control-plane API (Scalar over OpenAPI) **dev-only, never in production**.

## 8. Seams (external things BUILD cannot self-serve)

| Seam | Needed by | Fallback in repo |
|---|---|---|
| Railway workspace token + shared project bootstrap | PRD 04 live path | FakeSubstrate end-to-end |
| Stripe account keys (test mode first) | PRD 06 | Stripe test keys seam; fake billing adapter |
| GHCR (or registry) push credentials | PRD 08 | local docker build + FakeSubstrate deploy |
| `cloud.hogsend.com` DNS (Cloudflare) | launch | localhost |
| Legal copy for Terms/Privacy | PRD 03 | stub copy marked DRAFT |
| Redis key-namespacing verification in engine | density (later) | tiny per-tenant Redis (decided) |

## 9. Out of scope (this wave)

Shared multi-tenant engine process; group/agency plans; social login; SOC 2 tooling;
marketing site changes; migrating existing manual clients onto the control plane; Go CLI
deletion; DuckDB/Parquet analytics tier (parked, designated future answer for cold events).
