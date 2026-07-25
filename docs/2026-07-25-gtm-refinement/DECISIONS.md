# DECISIONS — GTM Extension, Release 1: Refinement

Locked global choices. Every PRD in this stack inherits them. Do not re-litigate.

Source of truth: the approved plan at `.claude/plans/lets-discuss-this-serialized-journal.md`
(GTM Extension — Release 1: Refinement), approved 2026-07-25.

---

## 1. Product definition

Hogsend gains **one** new capability: **Refinement** — pulling person + company intelligence for a
known contact from an external provider (Apollo first) and landing it as contact properties, so
behaviour-derived buckets can be qualified by fit.

The GTM positioning brief listed six features. Five already ship (`defineBucket`, `contacts.properties`,
bucket transition events, CRM/Slack/outbound destinations, attribution + holdout lift). Refinement is
the only genuinely new one. **This release does not build the other five.** See §6.

The loop being closed:

```
behaviour → bucket("gtm-high-intent")
              ↓ .on("enter")
            refineContact()                          ← NEW
              ↓ ingestEvent({ contactProperties })
            contacts.properties.refined_*
              ↓ re-runs checkBucketMembership synchronously
            score = plain TypeScript (fit × behaviour)
              ↓ ingestEvent({ contactProperties: { gtmScore } })
            bucket("gtm-qualified", b => b.prop("gtmScore").gte(20))
              ↓ .on("enter")
            notify sales / push to CRM
```

"Signal" = a bucket you can rank and sort. That is why the leaderboard work (PRD 06) is in scope:
without it you can enrich and score a contact and still not answer "who do I call today".

---

## 2. Architecture

Hogsend is a versioned engine consumed as a dependency. Refinement follows the **BYO provider**
pattern already used by email / SMS / analytics / CRM: a vendor-neutral contract in `@hogsend/core`,
a registry + container resolution in `@hogsend/engine`, and a thin `packages/plugin-<vendor>` adapter.

Placement, by package:

| Package | Gains |
|---|---|
| `packages/core` | `providers/enrichment.ts` — the contract + `defineEnrichmentProvider()` |
| `packages/db` | `enrichment_lookups` table + migration; GIN index on `contacts.properties` |
| `packages/engine` | registry, singleton, env preset, env vars, container wiring, `refineContact()`, `"refine"` key kind, cold-gate enforcement, admin contacts ordering |
| `packages/plugin-apollo` | NEW package — `createApolloProvider()` |
| `packages/studio` | one sortable property column on the contacts view |
| `apps/api` | example GTM buckets + scoring workflow (consumer content only) |

---

## 3. Design rules (non-negotiable — from the approved plan)

1. **`refineContact()` is a standalone import, never on `ctx`.** Mirrors `sendEmail()`, `sendSms()`,
   `sendConnectorAction()`. `JourneyContext` stays orchestration primitives only.
2. **Recompute scores, never increment.** `mergePropertiesSql` only overwrites with a literal — there
   is no SQL-side `+`, so a concurrent read-modify-write silently loses increments. A score that is a
   pure function of current state dissolves this, makes decay trivial, and is replay-safe.
3. **`ingestEvent` is the only sanctioned property write.** `resolveOrCreateContact` writes the jsonb
   but does **not** re-run `checkBucketMembership` — only `ingestEvent` does. Writing traits any other
   way breaks the loop in §1.
4. **Trait keys are flat and top-level.** `evaluatePropertyConditions` reads
   `journeyContext[condition.property]`; dotted paths do not resolve. Author `b.prop("refined_seniority")`,
   never `b.prop("properties.refined_seniority")`. Numeric values must be real JSON numbers —
   `conditions/property.ts` does no coercion, so `"42"` silently never matches a `gte`.
5. **The core contract stays vendor-neutral.** Apollo's response shape must not leak into
   `@hogsend/core`, the same discipline `EmailProvider` held against Resend.
6. **Every lookup costs money.** Ledger + TTL + negative cache + budget cap ship in this release, not
   a follow-up. The cap fails closed.
7. **Providers are dumb wires.** All DB, caching, budget, preference and ingest logic lives in the
   engine. A provider does one thing: query the vendor and normalise the response.

---

## 4. Quality gates

Run from the worktree root. Verbatim commands for every delivery brief:

```bash
pnpm lint                                        # biome check .
pnpm exec turbo run check-types --concurrency=2
pnpm exec turbo run test --concurrency=2
pnpm exec turbo run build --concurrency=2
```

**`--concurrency=2` is mandatory** on turbo runs. The full fan-out OOMs on this machine and surfaces
as exit 137 / "runner shutdown", which reads like a type error but is not.

`test` and `check-types` both `dependsOn: ["^build"]`, so upstream builds run implicitly.

### 4a. Test runners differ by package — check before writing a test

This repo does **not** use one runner. Putting a vitest-style test in the engine will not run.

| Package | Runner | Location | Command |
|---|---|---|---|
| `packages/core` | **vitest** | colocated `src/**/*.test.ts` (9 files) | `cd packages/core && pnpm test` |
| `packages/engine` | **node:test via `tsx --test`** — NOT vitest | colocated `src/**/*.test.ts` | `cd packages/engine && pnpm test` |
| `packages/plugin-*` | **vitest** | `src/__tests__/**/*.test.ts` | `cd packages/plugin-x && pnpm test` |
| `apps/api` | **vitest** | `src/__tests__/*.test.ts` (191 files) | `cd apps/api && pnpm test` |
| `packages/db` | none | — | verified via migration + `check-types` |

Use `import { test } from "node:test"` and `node:assert` for engine tests — copy the shape of the
nearest existing file (`packages/engine/src/lib/connector-actions.test.ts` is the closest analogue for
this release, and is exactly where PRD 05's tests belong).

**Fixed during this release — the engine test glob was silently one level deep.** The script was
`tsx --test src/**/*.test.ts`, unquoted, so `sh` (not Node) expanded `**` as a single `*`. Only
`src/<dir>/<file>.test.ts` matched: 7 test files existed on disk, 6 ran, and
`src/routes/admin/impact-wire.test.ts` had **never executed** — its coverage was fictional and both
`pnpm test` and the `turbo run test` gate reported green regardless. Now quoted
(`tsx --test 'src/**/*.test.ts'`) so Node's runner expands `**` recursively. Count went 24 → 27, all
passing. Any depth is now safe; before this fix, a test at `src/container.test.ts` would have been
silently skipped.

**Corollary for every task in this stack: a green gate is not evidence a new test ran.** Confirm the
test COUNT increased, or re-run with `--force`. Turbo replays cached logs — including logs recorded
before your test existed.

**Anything needing a live database goes in `apps/api/src/__tests__/`**, not in the engine — that is
the only suite wired to a real Postgres. Engine tests are pure/unit.

### 4b. Database for tests

This worktree runs its **own isolated stack**; the main checkout's containers (5434/6380) belong to
another agent — never point at them.

```bash
docker compose up -d postgres redis     # reads ./.env → 5438 / 6383
export DATABASE_URL='postgresql://growthhog:growthhog@localhost:5438/growthhog'
export REDIS_URL='redis://localhost:6383'
```

`apps/api/vitest.config.ts` hardcodes a *placeholder* `DATABASE_URL` (`…@localhost:5432/test`), and
turbo's `test` task declares `passThroughEnv: ["DATABASE_URL","REDIS_URL"]`. So an exported
`DATABASE_URL` overrides the placeholder and is what DB-backed suites actually use. Migrations are
already applied in this worktree (schema at `0064_curly_peter_parker`); after PRD 02 adds a migration,
re-run `DATABASE_URL=… pnpm db:migrate` from `packages/db`.

---

## 5. Conventions

- **TDD.** Failing test first, then green. Every task states its test target.
- **Conventional Commits**, enforced by commitlint via Lefthook. `type(scope): description`,
  header ≤ 100 chars, kebab-case scope.
- **One commit per task.** Local commits only — **no push, no branch beyond this one, no PR, no
  deploy** without an explicit instruction.
- **Never add a `Co-Authored-By` trailer.** Never mention any AI tool or vendor in a commit message.
- **`pnpm add <pkg>@latest`** — never hand-edit a version into `package.json`.
- **Biome** formatting: 2-space indent, double quotes, semicolons, 80-char width.
- ESM: `.js` extensions on relative imports inside engine/api.
- New engine npm dependencies must be mirrored into the scaffolder template's `_package.json`
  (consumers bundle via tsup `noExternal`).
- Branch: `feat/gtm-refinement`, worktree `.claude/worktrees/gtm-refinement`. The main checkout is
  shared with other agents — never work there, never `git checkout` in it.

---

## 6. Explicitly out of scope

Do not build these, and do not let a task drift into them:

- `defineSignal` — a bucket already is one.
- A `traits` primitive — `contacts.properties` is it.
- Email-domain derivation / account rollup. Groups exist but journeys still cannot be triggered by
  or read group state; that is a deliberate deferral.
- A Smartlead (or any) outbound-sender destination.
- A meeting-booked conversion definition.
- A Prospects-vs-Contacts Studio view.
- `ContactWriteBack` wiring into journey milestones.
- Group-level journeys, group merge/re-key, org-scoped group uniqueness.

Each is a clean follow-up. None blocks this release.

---

## 7. Seams

| Seam | Status |
|---|---|
| **Live Apollo API key** | **CLOSED 2026-07-25.** Key supplied and verified live (`POST /api/v1/people/match` → HTTP 200). Stored in the gitignored `.env` and `apps/api/.env` only; `apps/api/.env.example` carries a documented placeholder. The key appears in no tracked file and no commit — verified with `git check-ignore` and a history-wide `git grep`. PRDs still build against an injected `fetch` and a fake provider; the real key is for the PRD 07 smoke only. `ENRICHMENT_MONTHLY_LOOKUPS=50` locally so a test loop cannot burn the quota. |
| **Running Postgres for `apps/api` tests** | `docker compose up -d` provides TimescaleDB on 5434. The vitest config injects test env vars. Available locally; not a blocker. |
| **Publishing `@hogsend/plugin-apollo` to npm** | A brand-new `@hogsend/*` package's first publish must be manual — CI cannot create it. Out of scope for this run (no publishing). Note it for the release train. |

---

## 8. Publish mode

`local-commits-only`. Commit to `feat/gtm-refinement` in the worktree. No push, no PR, no npm
publish, no Railway deploy.
