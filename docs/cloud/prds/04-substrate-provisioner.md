# PRD 04 — Substrate abstraction + provisioner

## Goal
The heart of the product: `SubstrateProvider` (Fake + Railway), tenant-database creation on
the shared cluster, headless Hatchet tenant/token minting, and a durable provisioning
pipeline that takes a `requested` stack to `running` — with suspend/resume/destroy and a
health poll. Fully demonstrable against `FakeSubstrate`; live path wired behind the Railway
seam.

## Locked decisions (this PRD)
- `SubstrateProvider` interface (in `apps/cloud/src/substrate/types.ts`):
  `provisionStack(spec) → StackRefs` (spec includes the initial image tag),
  `destroyStack(refs)`, `setEnv(refs, vars)`,
  `redeploy(refs, { service? })`,
  `deployImage(refs, { imageUrl, service: "api" | "worker", preDeployCommand? })`,
  `attachDomain(refs, domain)`, `getHealth(refs, { service? })`, `suspend(refs)`,
  `resume(refs)` — the service selector + pre-deploy hook exist so PRD 08 can deploy
  worker-then-api with migrate as pre-deploy without widening the frozen seam. All inputs/outputs neutral types;
  `StackRefs` is the opaque jsonb stored on `stacks.substrate_refs` AND carries the api
  service's public URL (substrate-issued domain) — the provision pipeline uses it for
  `API_PUBLIC_URL`/`BETTER_AUTH_URL`.
- **Initial deploy source** — a freshly provisioned stack runs the **stock scaffold
  image** (a default create-hogsend build, tag `hogsend-default:<engine-version>`), so
  the instance is alive before the customer's first publish. Building that image is PRD
  08 work; FakeSubstrate doesn't care, and the live-Railway seam includes it.
- `FakeSubstrate` — deterministic in-memory implementation with scriptable failures
  (`failNext("provisionStack")`) for retry tests; used by all tests + local dev
  (`CLOUD_SUBSTRATE=fake` default).
- `RailwaySubstrate` — GraphQL v2 client (fetch-based, typed documents ported from the Go
  CLI's `cli/internal/railway/queries.go` as reference); retry w/ exponential backoff (max
  5) on 400/429/5xx; org project created lazily on first stack; rung-1 spec: Redis + api +
  worker services in the org project, `railwayConfigFile` pattern per existing tomls.
- **TenantDbService** — `CREATE DATABASE`/`CREATE ROLE` (random strong password) on the
  org's **cell** cluster (admin DSN from the PRD 02 `cells` row; local dev seeds one cell
  pointing at compose PG); revoke public; DSN returned for stack env with a SMALL pool
  (`?pool_max=3`-style params — per-tenant stacks must not hold fat pools against a
  shared cluster). Idempotent (IF NOT EXISTS semantics via catalog checks).
- **HatchetTenantService** — port the headless register-or-login → ensure-tenant →
  create-token flow (reference: `hogsend hatchet token` in @hogsend/cli) against the
  cell's Hatchet URL; returns token; namespace = stack id.
- **Provision is enqueued at creation** — the API layer enqueues `provision-stack` via
  the cloud Hatchet client immediately after the PRD 02 trio commits (org signup AND
  later environment creation). No operator action required.
- **Provisioning pipeline** — a Hatchet durable task in cloud-worker (`provision-stack`):
  steps = create tenant DB → mint Hatchet tenant/token → substrate.provisionStack →
  setEnv (full engine env: DATABASE_URL, REDIS_URL, BETTER_AUTH_SECRET generated,
  HATCHET_* , API_PUBLIC_URL, `EMAIL_FROM`/`EMAIL_DOMAIN` when set (PRD 05),
  `HOGSEND_BOOTSTRAP_API_KEY=false`, HOGSEND_TEST_MODE for test envs, provider keys from
  PRD 02) → poll `getHealth` until healthy (timeout 10m) → **mint tenant credentials**
  (first Studio admin + an ingest-scoped API key, headlessly against the tenant DB /
  admin API — reference the CLI's studio-admin + key-mint flows; store the key encrypted
  PRD-02-style, surface ingest URL + key + Studio access on the environment page) →
  transition `running`.
- **cloud-worker Hatchet env** — `CLOUD_HATCHET_CLIENT_TOKEN` (required when substrate
  features are on; boot fails closed without it), `CLOUD_HATCHET_CLIENT_HOST_PORT`
  (default `localhost:7077`), `CLOUD_HATCHET_CLIENT_TLS_STRATEGY` (default `none`). Every step
  idempotent (safe re-run); failures transition to `error` with `last_error`, retryable
  from dashboard. cloud-worker gets its own Hatchet client (SDK direct, own namespace
  `cloud`).
- Suspend/resume/destroy: service methods + tasks driving the matching substrate calls +
  state transitions; destroy also drops the tenant DB (guarded: only from `suspended`).
- Health poll: recurring task (cron via Hatchet) sweeping `running` stacks →
  `stack_health` rows (status, latency, engine schema version from `/v1/health`).
- Dashboard wiring: environment page shows live status/health, buttons for retry/suspend/
  resume/destroy (role-gated, destructive confirms).

## EARS acceptance criteria
- WHEN an organization is created, the system SHALL enqueue provisioning for its
  production stack without operator action.
- WHEN a stack in `requested` is provisioned against FakeSubstrate, the system SHALL walk
  provisioning → running, having created a tenant DB record, a Hatchet token, minted a
  Studio admin + an ingest API key (stored encrypted, surfaced on the environment page),
  and set the full engine env on the substrate, with each step audit-logged.
- WHEN a substrate step fails transiently, the system SHALL retry with backoff and
  succeed without duplicating side effects (idempotency proven by scripted double-run).
- WHEN a step fails permanently, the stack SHALL land in `error` with `last_error`, and a
  dashboard retry SHALL resume from the failed step, not from scratch.
- WHEN destroy is confirmed on a `suspended` stack, the system SHALL call
  `destroyStack`, drop the tenant database, and transition to `destroyed`; destroy from
  `running` SHALL be rejected.
- WHEN the health poll finds a `running` stack unhealthy 3 consecutive sweeps, the system
  SHALL surface a dashboard alert state (no auto-transition).
- WHEN `CLOUD_SUBSTRATE=railway` with no token configured, boot SHALL fail closed with a
  clear error (never silently fake).

## Tasks
1. **SubstrateProvider types + FakeSubstrate** — interface, neutral types, fake with
   scriptable failures; contract test suite that any implementation must pass.
   _Boundary:_ `apps/cloud`. _Depends:_ PRD 02
2. **TenantDbService + HatchetTenantService** — TDD against local compose PG + local
   hatchet-lite (idempotency, revoke, token mint). _Boundary:_ `apps/cloud`. _Depends:_ 1
3. **cloud-worker Hatchet wiring + provision pipeline** — SDK client, `provision-stack`
   durable task, env assembly (incl. provider keys), health-wait, transitions, retry
   semantics. _Boundary:_ `apps/cloud`. _Depends:_ 2
4. **Suspend/resume/destroy + health poll cron** — tasks, guards, `stack_health` table
   (migration), alert state. _Boundary:_ `apps/cloud`. _Depends:_ 3
5. **RailwaySubstrate** — GraphQL client + implementation passing the contract suite
   (mocked transport tests; live path behind seam), backoff, org-project lazy create.
   _Boundary:_ `apps/cloud`. _Depends:_ 1
6. **Dashboard operations UI** — status/health surfaces, retry/suspend/resume/destroy
   controls with confirms + role gates. _Boundary:_ `apps/cloud`. _Depends:_ 3 (+PRD 03)

## Seams
Railway workspace token + one-time shared-project bootstrap (shared PG cluster + shared
hatchet-lite on Railway) — enumerate exact manual steps when reached; everything demoable
on FakeSubstrate + local compose meanwhile.

## Done when
Contract suite green on Fake AND Railway(mocked); full provision→running→suspend→destroy
walked on FakeSubstrate from the real dashboard in the browser; gates green.

## Implementation Notes
Shipped in 6 commits + 1 fix; 331 tests on close. The seam held: RailwaySubstrate passes
the identical contract suite as FakeSubstrate (mocked transport; emulator throws on
unknown operations). Decisions that stuck: poolMax travels as DATA not DSN params
(postgres-js silently ignores URL pool params when the caller passes options — verified
in driver source; engine follow-up `DATABASE_POOL_MAX` folded into PRD 06);
`create()` never rotates a live tenant-db password (alreadyExists + explicit
resetCredentials); Hatchet tokens are additive, never deduped; suspend = replicas 0
(Railway has no pause mutation); destroy keeps the org project (sibling envs);
mint-credentials step is a recorded no-op stub until a real engine boots (PRD 08 image).
SHIPPED BUG FIXED: proxy judged sessions by cookie PRESENCE → a dead cookie ping-ponged
/login ↔ / as sub-second meta-refresh reloads ("rerendering every frame"); auth screens
now always allowed at the proxy, real-session bounce lives in the pages. KNOWN GAP →
PRD 10: a stack whose enqueue died with its process strands at `requested` — needs the
stuck-provision reconciler sweep (re-enqueue stale requested/provisioning). Live seam
still owed: workspace token is stored + validated (lists projects); shared-cell
bootstrap + default image (PRD 08) before first live provision. Overview copy nit: a
`requested` stack is described as mid-transition — soften when PRD 10 lands the sweep.
