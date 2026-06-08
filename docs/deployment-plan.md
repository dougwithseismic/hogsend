# Hogsend Deployment Plan — self-host by default, Hatchet bring-your-own

Status: planning only. This document changes no deploy config and ships no code. It
is the agreed design for moving Hogsend from a Railway-shaped deploy story to a
self-host-by-default story with Railway demoted to one paved option, while keeping
Hatchet exactly as it is and leaving the door open for a future managed/cloud version.

---

## 0. Decide-first (read before building)

These are load-bearing decisions the plan takes a position on. They are surfaced up
front because getting any of them backwards costs a rebuild or a security hole.

1. **Hatchet token auto-mint is NOT proven feasible.** The whole "turnkey" idea
   rests on a `hatchet-admin token create` CLI inside the pinned
   `ghcr.io/hatchet-dev/hatchet/hatchet-lite:latest` image. No file in the repo
   references it; every real artifact (`packages/create-hogsend/template/env.example:21`,
   `README`, `skills/manage-hogsend/references/provision.md`, `troubleshoot.md`)
   documents only the manual dashboard flow (`admin@example.com` / `Admin123!!` at
   `:8888` → Settings → API Tokens). **Verdict: ship auto-mint as a best-effort
   helper with the manual dashboard step as the guaranteed contract. The one-command
   story must not DEPEND on auto-mint.** Empirically verify the CLI (exec into the
   running container, confirm binary + flags + `--config` path + seeded tenant-id)
   before any auto-mint code is written. See §5.

2. **`HATCHET_CLIENT_TLS_STRATEGY` default = `tls`** (secure, matches the SDK).
   The local insecure hatchet-lite path explicitly sets `none` in compose/`.env`.
   We do NOT default to `none` — that would silently ship plaintext gRPC for every
   BYO/Cloud user who forgets to override. This resolves the dimension-level
   contradiction in favour of secure-by-default.

3. **Advisory lock: the CODE is right, the COMMENT in `railway.toml.phase6` is
   WRONG.** `packages/db/src/migrate.ts:22` uses one shared key `4812007` for both
   tracks; each track does its own acquire+release, so engine and client serialize
   correctly and never deadlock (confirmed by reading lines 17-21 and 45-77). The
   phase6 comment claiming the tracks "must use a different key" is actively wrong
   advice. **Action: delete/correct the phase6 comment. Do NOT split the key.**

4. **Tenant column now (the only irreversible item).** Add a nullable
   `organization_id` to `contacts`, `journey_states`, `user_events`, `email_sends`,
   `api_keys` on the ENGINE track, AND include it in the
   `uq_user_journey_active(userId, journeyId, status)` unique index
   (`packages/db/src/schema/journey-states.ts:33`). Adding the column later onto
   multi-million-row `user_events` is a lock-prone backfill; rebuilding that unique
   index later is worse. This is cheap insurance now, expensive debt later. See §6.

5. **Railway Dockerfile-build cutover is OUT OF SCOPE.** `railway.toml` is the LIVE
   dogfood api service. Switching it from railpack to `builder = DOCKERFILE` is a
   behaviour change on a running service and is a separate, tested change — not part
   of this docs/packaging reframe.

6. **One canonical env-contract file, in-network service names.** The single source
   of truth is `packages/engine/src/env.ts` (validation) projected into ONE annotated
   `.env.example`. The Docker/compose example uses in-network service names
   (`postgres:5432`, `redis:6379`, `hatchet-lite:7077`), not host-mapped ports. The
   existing `apps/api/.env.example` host bug (`:5432`/`:6379` — confirmed) is fixed to
   `:5434`/`:6380` for the host-process dev path. Host-process and in-compose are
   mutually exclusive port regimes and the templates say which is which.

7. **`BETTER_AUTH_SECRET` generation is in scope.** `pnpm bootstrap` today
   `cp`s `.env.example` whose secret is the literal `your-secret-here-...` placeholder
   and the schema only enforces `min(1)`. A fresh self-hoster runs with a
   publicly-known auth secret. `scripts/bootstrap.sh` must generate a real
   `openssl rand -base64 32` value.

8. **The worker must be gated on migrations too.** `getEngineSchemaVersion` +
   `process.exit(1)` lives only in the API boot path; `worker.ts` has no schema guard
   and no healthcheck. In compose the worker `depends_on` the `migrate` one-shot
   completing, otherwise it crash-loops silently against an unmigrated DB.

9. **Railway monorepo watch paths are a live landmine — engine changes silently
   don't deploy.** Confirmed empirically: the worker fix (`apps/api/tsup.config.ts`,
   commit `b197eb3`) triggered a Railway build and cut over, but the redis `family:0`
   fix (`packages/engine/src/lib/redis.ts`, commit `9dd065e`) **never built** — the
   `hogsend-api`/`hogsend-worker` services appear scoped to redeploy only on
   `apps/api/**`. Since the entire engine + all shared code lives in `packages/`,
   this means *most* code changes never ship. **Action: set each service's watch
   path to the repo root (or `apps/api/**` + `packages/**`)**, and as part of the
   Railway phase verify a `packages/`-only change triggers a redeploy. This is why
   redis is still `down` in production right now — the fix is committed but undeployed.

---

## 1. Principles & deployment model

**Hatchet stays.** We do not swap, wrap, or abstract away Hatchet. Its durable
execution (`ctx.sleep` surviving restarts) is core value. Hogsend depends on Hatchet
through exactly one config contract (token + host_port + tls_strategy) and nothing
more.

**Bring-your-own-Hatchet.** Onboarding Step 1 is "acquire a Hatchet" — Hatchet Cloud,
self-hosted hatchet-lite, or an existing instance. It is a prerequisite, and that is
fine. Hogsend connects to whatever you point it at via the three `HATCHET_CLIENT_*`
env vars.

**Self-host by default.** Anyone can run Hogsend on their own box/VPS with Docker.
The default deploy narrative is `docker compose`, backed by a real Dockerfile (which
does not exist today — the single biggest gap).

**Railway is one paved option.** We keep `railway.toml` / `railway.worker.toml` and
the one-click template, but demote them from "the way" to "a way."

**Future-cloud-safe.** A managed/multi-tenant version may happen someday. Decisions
now must not block it, but we are NOT building it now. The seam is the DI container
(`createHogsendClient` in `packages/engine/src/container.ts`) plus the already-enabled
Better Auth `organization` plugin plus Hatchet's native `HATCHET_CLIENT_NAMESPACE`.

The deployment model in one paragraph: **one runtime image, built once from the
monorepo, run three ways (api / worker / migrate) via command override; every deploy
target is the same image plus the same validated env contract with different values;
the default target is self-host Docker on any box; Railway is one paved on-ramp that
consumes the same image and contract; nothing bakes in single-tenancy, so a future
cloud control plane can schedule N copies of the same image with per-tenant config
injected.**

---

## 2. Target architecture & deploy matrix

One multi-stage `Dockerfile` at repo root builds the pnpm monorepo and produces ONE
image. Three commands off that image:

- **api** → `node apps/api/dist/index.js` (HTTP, healthcheck `/v1/health`, port 3002)
- **worker** → `node apps/api/dist/worker.js` (durable task executor, no port, no
  healthcheck)
- **migrate** → one-shot, `pnpm --filter @hogsend/db db:migrate && pnpm --filter
  @hogsend/db db:migrate:client` (engine track then client track)

Both api and worker are the same codebase by design (two entry points). The image must
ship `apps/api/dist` AND `packages/db` source + its `drizzle/` SQL + `tsx` +
`drizzle-orm` + `postgres`, because migrations run via `tsx src/migrate.ts` and resolve
`new URL("../drizzle", import.meta.url)` at runtime (`migrate.ts:92`) — they are NOT in
the tsup bundle.

### Deploy matrix

| Concern | local dev (host process) | docker self-host (DEFAULT) | Railway (one paved option) | BYO / Hatchet Cloud |
|---|---|---|---|---|
| API + worker run | `pnpm dev` / `pnpm worker` on host | api+worker compose services from the image | two Railway services, same image (future) | operator's own orchestrator |
| Infra (pg/redis/hatchet) | `docker compose up -d` (infra-only) | `docker-compose.prod.yml` (full stack) | Railway services + hatchet-lite | operator-provided |
| `DATABASE_URL` | `...@localhost:5434/growthhog` | `...@postgres:5432/growthhog` | `*.railway.internal` | operator value |
| `REDIS_URL` | `redis://localhost:6380` | `redis://redis:6379` | `*.railway.internal` (family:0 hack) | operator value |
| `HATCHET_CLIENT_HOST_PORT` | `localhost:7077` | `hatchet-lite:7077` | `hatchet-lite.railway.internal:7077` | Cloud addr (or token-embedded) |
| `HATCHET_CLIENT_TLS_STRATEGY` | `none` | `none` | `none` (internal net) | `tls` (Cloud) |
| `HATCHET_CLIENT_TOKEN` | minted vs local lite / pasted | minted vs local lite / pasted | minted vs Railway lite / pasted | pasted from Cloud |
| Migrations run via | `pnpm db:migrate` manually | `migrate` one-shot, `depends_on` healthy pg | Railway `preDeployCommand` | operator runs migrate command |
| API boot schema guard | yes (`process.exit(1)` if behind) | yes | yes | yes |
| Worker schema guard | none (gated by `depends_on` migrate) | none (gated by `depends_on` migrate) | none | operator orders migrate first |

The only things that vary per target are the VALUES of the always-required set and the
TLS strategy. The `family: 0` ioredis setting in `packages/engine/src/lib/redis.ts` is a
Railway-IPv6 accommodation — harmless elsewhere, kept, documented as Railway-motivated,
NOT a contract requirement.

---

## 3. Step 1 — Acquire a Hatchet (three audiences, one contract)

Hogsend depends on Hatchet through exactly three values, read by
`@hatchet-dev/typescript-sdk` straight from `process.env` (`packages/engine/src/lib/
hatchet.ts` is just `HatchetClient.init()`):

- **`HATCHET_CLIENT_TOKEN`** — bearer JWT. The SDK hard-throws if empty. The ONLY
  truly mandatory value.
- **`HATCHET_CLIENT_HOST_PORT`** — gRPC address. Falls back to the address embedded in
  the token's claims, but we always set it explicitly for clarity/debuggability.
- **`HATCHET_CLIENT_TLS_STRATEGY`** — `tls` (default, Cloud) or `none` (insecure local
  hatchet-lite).

This contract is identical across all three audiences; only the values differ.

- **Path A — Hatchet Cloud (managed, paste a token).** Zero infra. Create a tenant,
  generate an API token, paste it. `TOKEN` set, `HOST_PORT` from the token's embedded
  address (or set explicitly), `TLS_STRATEGY=tls`. Lowest friction; also the natural
  fit for a future managed Hogsend.
- **Path B — self-host hatchet-lite via our compose (turnkey, THE default).** Bring up
  hatchet-postgres + hatchet-lite, wait healthy, obtain a token (auto-mint helper if
  proven, else the documented dashboard step), set it. `HOST_PORT=hatchet-lite:7077`,
  `TLS_STRATEGY=none`.
- **Path C — bring-your-own existing Hatchet.** Supply all three values manually. The
  escape hatch; no bootstrap magic.

The token chicken-and-egg (hatchet-lite must boot before a token can exist, but
api/worker need the token to boot) is resolved by ordering, not magic: infra → token →
app. See §5 for the bootstrap design and its feasibility verdict.

---

## 4. Engineering phases (ordered, each independently shippable, each leaves repo green)

Each phase is self-contained and does not break `pnpm build` / `pnpm check-types` /
`cd apps/api && pnpm test`.

### Phase 1 — Env contract (no infra, foundation for everything)
Artifacts:
- `packages/engine/src/env.ts`: promote `HATCHET_CLIENT_TOKEN` to required
  (`z.string().min(1)`); add `HATCHET_CLIENT_HOST_PORT` (`z.string().default(
  "localhost:7077")`) and `HATCHET_CLIENT_TLS_STRATEGY`
  (`z.enum(["none","tls","mtls"]).default("tls")`); fold in `SKIP_SCHEMA_CHECK`
  (`z.coerce.boolean().default(false)`, currently read raw in `index.ts`) and
  `CLIENT_MIGRATIONS_FOLDER` (optional, currently read raw in `migrate-client.ts`);
  add `HATCHET_CLIENT_NAMESPACE` (optional, default empty — the future tenant knob).
- Guard the required token behind `NODE_ENV !== "test"` OR inject a dummy token in
  `apps/api/vitest.config.ts`, so the suite (which calls `app.request()` directly)
  stays green. **This is the green-keeping risk for this phase.**
- Note in code/docs: env.ts validation is a presence check only; the SDK still reads
  `process.env` independently, so values must agree. "Single contract" = one schema +
  one example; it does not make env.ts the sole reader.

### Phase 2 — Canonical `.env.example` + secret generation + bootstrap.sh
Artifacts:
- ONE annotated `.env.example` (owner: engine) projected to `apps/api/.env.example`
  and `packages/create-hogsend/template/env.example`. Fix the host-port bug
  (`:5432`→`:5434`, `:6379`→`:6380`) in the dogfood file. Each var annotated
  `[required] / [default: x] / [optional]` with per-target value.
- `scripts/bootstrap.sh`: generate `BETTER_AUTH_SECRET` via `openssl rand -base64 32` and
  write it into the generated `.env` instead of copying the placeholder; add a
  `pnpm gen:secret` helper.
- Replace the "copy token from dashboard at :8888" comment with "auto-populated by the
  token bootstrap / `pnpm hatchet:token`, or paste from your Hatchet."

### Phase 3 — Dockerfile + `.dockerignore` (the central missing artifact)
Artifacts:
- `/Dockerfile`, 4-stage on `node:22-bookworm-slim` (matches `.node-version`),
  corepack `pnpm@9.0.0` (matches root `packageManager`):
  1. `base` — node + pinned pnpm.
  2. `fetch` — COPY lockfile + `pnpm-workspace.yaml` + all `package.json`; `pnpm fetch`.
     Caches on lockfile hash only.
  3. `build` — COPY full source; `pnpm install --frozen-lockfile --offline`;
     `pnpm --filter @hogsend/api build`.
  4. `runner` — slim, non-root `node` user, `NODE_ENV=production`. COPY
     `apps/api/dist` + `packages/db` (incl. `drizzle/` + meta) + pruned prod deps +
     `tsx` + `drizzle-orm` + `postgres`. Default `CMD` runs the api directly
     (`node apps/api/dist/index.js`). Migrations MUST work in this image.
- `/.dockerignore`: exclude `node_modules`, `**/dist`, `.git`, `.turbo`, `apps/docs`,
  `cli`, `*.png` (the ~4MB banners), `.env*`, `**/__tests__`, `docs`. Mandatory or the
  build context balloons and cache busts on every edit.
- Smoke test: build the image, run `migrate` one-shot against a throwaway pg, confirm
  `db:migrate` finds the drizzle SQL.

### Phase 4 — Production compose (full self-host stack)
Artifacts:
- `/docker-compose.prod.yml` extending the existing infra-only topology and ADDING
  `migrate`, `api`, `worker`. Ordering via healthchecks:
  - `postgres` / `redis` / `hatchet-postgres` / `hatchet-lite`: healthchecks +
    `restart: unless-stopped` + named volumes.
  - `migrate`: `build .`, runs the two-track migrate, `restart: "no"`,
    `depends_on: postgres { condition: service_healthy }`.
  - `api`: `depends_on` postgres+redis+hatchet-lite healthy AND `migrate`
    `service_completed_successfully`; healthcheck `/v1/health`; `restart:
    unless-stopped`; port 3002.
  - `worker`: same `depends_on` (including `migrate` completed — closes the
    no-worker-guard gap); NO healthcheck; `restart: unless-stopped`.
- Parameterize hatchet-lite for non-localhost: `SERVER_URL`,
  `SERVER_GRPC_BROADCAST_ADDRESS`, cookie domain via `${HATCHET_HOST:-localhost}` so
  the same compose works on localhost and a real-domain VPS. (Note: the minted token
  embeds the broadcast address, so a VPS token is domain-specific — documented in §5.)
- In-network env defaults: `DATABASE_URL=postgres://growthhog:growthhog@postgres:5432/
  growthhog`, `REDIS_URL=redis://redis:6379`, `HATCHET_CLIENT_HOST_PORT=hatchet-lite:
  7077`, `HATCHET_CLIENT_TLS_STRATEGY=none`.

### Phase 5 — Hatchet token bootstrap (best-effort, manual fallback is the contract)
See §5 for the full design and feasibility verdict. Artifacts gated on empirical
verification of the mint CLI:
- `scripts/hatchet-token.sh` + `pnpm hatchet:token`: bring up hatchet-postgres +
  hatchet-lite, poll health, attempt non-interactive mint, write token into `.env`
  (idempotent: skip if a non-empty token already present). On failure, print the
  documented dashboard steps. NEVER block the stack on this succeeding.
- Optional `hatchet-token-init` one-shot compose service once the CLI is confirmed and
  the app runs in a container (depends on Phases 3-4).
- A documented "rotate / volume-wipe recovery" path: delete the cached token, re-run
  `pnpm hatchet:token`.

### Phase 6 — create-hogsend template parity
Artifacts:
- Mirror `Dockerfile`, `.dockerignore`, `docker-compose.prod.yml` into
  `packages/create-hogsend/template/` so scaffolded repos self-host by default.
- Keep the template `railway.toml` / `railway.worker.toml` unchanged (Railway stays
  paved). Reconcile the template's single-process `scripts/migrate.ts` vs the
  two-command prod path — pick one runner shape and reuse it everywhere (collapse the
  three migrate entrypoints onto one to avoid institutionalizing drift).
- Register new files in `packages/create-hogsend/src/template-manifest.ts`.

### Phase 7 — Docs / README reframe
Artifacts:
- Split `apps/docs/content/docs/operating/deployment.mdx` into a target-neutral
  "Deploy" hub + three siblings: `deploy-docker.mdx` (DEFAULT, first),
  `deploy-railway.mdx` (existing content verbatim, "one paved option"),
  `deploy-byo.mdx`.
- New `getting-started/hatchet.mdx` = Step 1 "Acquire a Hatchet" (three paths +
  contract table). Link as prerequisite #1.
- Demote the Railway deploy button in root `README.md` below a Docker quickstart.
- Rewrite `skills/manage-hogsend/references/provision.md` + `CLAUDE.md` off Railway MCP
  tools onto the `railway` CLI (per the no-MCP-Railway memory) and reframe the 6-service
  topology + the `LxSCyR` button as "one paved Railway path."

### Phase 8 — CLI multi-target deploy + `doctor`
Artifacts:
- `cli/internal/config`: add `Target` (`docker|railway|byo`); `RailwayConfig` becomes
  one adapter; default to `railway` when a Railway block is present (back-compat).
- `cli/cmd/init.go`: target picker as the FIRST prompt; only collect the Railway token
  when `target == railway`.
- `cli/cmd/deploy.go`: dispatch by target — docker → `docker compose -f
  docker-compose.prod.yml up -d --build` + migrate one-shot; railway → existing
  `RedeployService`; byo → emit env + commands.
- `cli/cmd/doctor.go`: target-independent preflight reusing `internal/health` (hits
  `/v1/health`, reports `schema.engine`/`schema.client` `inSync`) and adding three
  reachability probes: Postgres via `DATABASE_URL`, Redis via `REDIS_URL`, Hatchet gRPC
  dial at `HATCHET_CLIENT_HOST_PORT` + token-present check. Requires NO Railway token.

### Phase 9 — Tenant column (cheap insurance, future-cloud)
Artifacts:
- Add nullable `organization_id` (text, default sentinel `"default"`, indexed) to
  `contacts`, `journey_states`, `user_events`, `email_sends`, `api_keys` on the ENGINE
  track. Generate via `cd packages/db && pnpm db:generate`.
- Add `organizationId` to the `uq_user_journey_active` unique index key
  (`journey-states.ts:33`) — the only genuinely irreversible piece.
- Self-host always writes the sentinel; behaviour is identical. See §6.

Phase ordering note: Phases 1, 2, 7, 9 are independent. Phase 4 depends on 3. Phase 5
depends on 3-4 for the container-init variant but the helper script can land alongside
2. Phase 8 depends on 4.

---

## 5. Hatchet token bootstrap — the crux

**Feasibility verdict (from the critic, adopted): NOT feasible as an auto-only design.
The mechanism is internally coherent — the minted JWT carries `sub` (tenant_id),
`server_url`, and `grpc_broadcast_address`, so a token minted against the seeded
hatchet-lite tenant WOULD let api/worker connect — but the design hinges on a
`hatchet-admin token create --config /hatchet/config --tenant-id <seeded>` CLI that NO
repo file references and that is unverified in the pinned `:latest` image. Every actual
artifact documents only the manual dashboard flow.**

Therefore:

1. **The contract is: acquire a token (Step 1, bring-your-own).** The manual dashboard
   step (`admin@example.com` / `Admin123!!` at `:8888` → Settings → API Tokens) is the
   guaranteed path the one-command story falls back to. It must be documented as the
   baseline.
2. **Auto-mint is a best-effort happy-path helper**, only after someone execs into the
   running `hatchet-lite` container and confirms: (a) the binary exists, (b) the exact
   command + `--config` path, (c) the ACTUAL seeded default tenant-id for the
   single-binary lite (do NOT assume the multi-service compose tenant-id
   `707d0855-...`). Pin hatchet-lite to a specific tag, not `:latest`, before relying
   on the CLI.
3. **Security caveats baked into the design:**
   - The token is an effectively-immortal JWT cached in plaintext (`.env` or a volume).
     Fine for a single-tenant box; combined with the unrotated default
     `admin@example.com` / `Admin123!!` it means any network-exposed self-host ships a
     known admin login + a long-lived token. Document changing the admin credentials.
   - The token embeds `grpc_broadcast_address`. A token minted against a localhost lite
     is silently non-portable: move to a real domain/Railway-internal and the embedded
     address is wrong, but a not-yet-expired token "looks valid." `HATCHET_CLIENT_HOST_PORT`
     must override, and the idempotent "skip if file exists" helper must NOT mask a
     stale-address token after a host move. Documented rotate path: delete cached token,
     re-run `pnpm hatchet:token`.
   - Writing a container-minted token into a bind-mounted host `.env` has cross-OS
     file-ownership hazards. Prefer the volume-file + helper-script read for the
     host-process dev model until the app is containerized.
4. **TLS default is `tls`** (§0.2) so Cloud/BYO are secure; compose/`.env` set `none`
   for the local insecure lite.

---

## 6. Future-cloud-proofing — cheap insurance vs safe to defer

The codebase is already well-positioned: the DI container (`createHogsendClient` in
`packages/engine/src/container.ts`, set per-request via `c.set("container")`) is the
single composition root; `overrides` already lets `db`/`auth`/`hatchet`/`mailer` be
swapped; Better Auth's `organization` plugin is already enabled with
`organization`/`member`/`invitation` tables + `session.activeOrganizationId`; and the
Hatchet SDK natively supports `HATCHET_CLIENT_NAMESPACE` (per-tenant isolation on one
shared engine). The email/analytics providers already take credentials as plain args.

**Cheap insurance NOW (Phase 9 + Phase 1):**
- Nullable `organization_id` on the five domain tables + in the
  `uq_user_journey_active` index key. The only irreversible item; trivial as an
  additive migration now, lock-prone/blocking later.
- `HATCHET_CLIENT_NAMESPACE` declared as a documented (default-empty) env knob.
- Keep config resolution funnelled through the container (opportunistically move
  `REDIS_URL` out of `lib/redis.ts` and `POSTHOG_*` out of `lib/posthog.ts` into
  `createHogsendClient`). Low priority, not a blocker.

**Safe to DEFER (explicitly not building now):** per-request tenant-resolution
middleware, a control-plane/tenant-registry DB, per-tenant Hatchet token minting,
Postgres RLS enforcement, usage metering/quotas, multi-tenant routing/ingress. All
un-blocked by the cheap-insurance items above.

When the managed version is built, it is additive: wrap container construction in a
tenant resolver (uses existing `overrides`), set a per-tenant Hatchet namespace, inject
per-tenant Resend keys via `createResendProvider({ apiKey })`, scope on
`organization_id` (optionally RLS). Avoid baking Railway specifics (the `family:0` hack,
`RAILWAY_PUBLIC_DOMAIN`) into the contract — keep them as target-specific value
mappings. Keep the seeded-tenant-id / admin-mint assumptions entirely in the
compose/init layer so the engine stays tenant-agnostic.

---

## 7. Non-goals

- **No Hatchet swap or abstraction.** Hatchet stays; hatchet-lite is the self-host
  story; the engine only ever sees the three-value connection contract.
- **No multi-tenant / managed build now.** Only the nullable column + index key +
  namespace knob land — no resolver, no control plane, no RLS, no metering.
- **No Railway live-service build cutover** (railpack → Dockerfile on `railway.toml`)
  in this effort — separate, tested change.
- **No deploy, no Railway changes, no app code in the planning phase** — this document
  only.
- **No reliance on auto-minting the Hatchet token.** The manual acquire-a-token step is
  the contract; auto-mint is a best-effort convenience.

---

## 8. Deploy safety — the CI gate (implemented)

Builds are deterministic (the Dockerfile, not railpack) and every change is gated
by CI (`.github/workflows/ci.yml`), so "it works" is verified, not hoped:

- **quality** — `pnpm lint` + `pnpm check-types`
- **test** — `pnpm test` against a TimescaleDB service with migrations applied
- **migrations** — schema-drift, fresh-apply, idempotency, client track, and
  upgrade-from-previous-release-with-data
- **preflight** — `bash scripts/preflight-deploy.sh`: builds the production image
  exactly as Railway does and **boots api / worker / migrate**, asserting clean
  startup. This is the gate that catches the runtime-packaging class lint/types/
  tests cannot (tsup `noExternal` gaps → `ERR_MODULE_NOT_FOUND`; `pnpm`-as-start →
  `EACCES`; winston File transport → `mkdir /app/logs` `EACCES`).

Run the same gate locally before pushing anything runtime/build/deps-related:
`pnpm preflight`.

**One manual step to fully gate deploys (Railway dashboard, once per service):**
enable **Wait for CI** on `hogsend-api` and `hogsend-worker`
(Service → Settings → Deploy → "Wait for CI" / Check Suites). Railway then holds
each deploy until the GitHub CI checks (incl. preflight) pass — so a red build
never reaches prod, even on a direct push to `main`. Not settable via the
`railway` CLI; it's a one-time toggle.
