# PRD 04 — Railway provisioning plane distillation (BUILD)

> **Status: promoted to a build wave (2026-08-16).** The second pillar of `apps/cloud` — the control
> plane that provisions each customer their own Hogsend instance on Railway. This wave distills the
> `runProvisionPipeline` god-function into individually-testable step units driven by the existing
> `PROVISION_STEPS` list. **Behavior-preserving; zero regression.** The healthy seams (`substrate/`,
> `images/`) are NOT touched.

## Build decisions (locked for this wave)

- **Scope is `apps/cloud/src/pipeline/provision.ts` ONLY.** Public exports keep their identity and
  signatures — `runProvisionPipeline({ stackId }, overrides?)`, `PROVISION_STEPS`, `ProvisionStep`,
  `failedProvisionStep`, `provisionAuditAction`, `PROVISIONER_ACTOR`, `ProvisionDeps`,
  `ProvisionResult`, `ProvisionStepReport`, `StackSecrets`, `emailProviderVars`, `findOwnerEmail`.
  The three production callers (`enqueue.ts:101`, `hatchet.ts:115`, `provision-sweep.ts:233`) and the
  test callers stay byte-compatible.
- **The distillation shape.** Introduce a per-run mutable `RunState` (holds the values currently
  threaded as `try`-block locals: `stack`, `context`, `tenantDsn`, `poolMax`, `hatchetToken`,
  `hatchetHostPort`, `namespace`, `refs`, `engineVersion`, `secrets`, `sesTenant`, `steps`, and the
  short-circuit + `welcome` signals). Each of the 11 `PROVISION_STEPS` becomes a named
  `async function step<Name>(state, deps): Promise<void>` that mutates `RunState`, pushes its
  `ProvisionStepReport`, and writes its own audit row — lifting the existing `// ---- step ----`
  blocks out verbatim. A `STEP_FNS: Record<ProvisionStep, StepFn>` map (typed so TS FAILS if a step
  is missing) drives them. `runProvisionPipeline` becomes the driver: set `current`, loop
  `PROVISION_STEPS`, keep the SINGLE `try/catch → recordError` and the OUTSIDE-try welcome send
  exactly where they are.
- **The two sharp edges, preserved exactly:**
  1. `start`'s early return — a `running` stack returns `{ status: "running", steps }` WITHOUT
     running further steps, WITHOUT `finish`, and WITHOUT a welcome send. Model this as a
     `state.shortCircuit` flag the driver checks after each step (only `start` sets it); on set, the
     driver returns the running result immediately. Do NOT throw (that would hit the catch).
  2. `finish` sets `state.welcome`; the welcome send stays OUTSIDE the `try` (its throw must not land
     in the catch and re-enter `recordError` on a non-failable `running` status).
- **The `audit` closure** (currently capturing `deps.db` + `stackId`) becomes a small helper the step
  functions call — same `writeAudit(...)` payload, same `provisionAuditAction(step)` action. No audit
  row added, removed, or reordered.
- **Idempotency/skip logic is copied, never re-derived.** Each step's `skipped` computation and its
  persisted-artifact short-circuit (encrypted DSN, Hatchet token, `substrate_refs`, stored secrets)
  move verbatim. The refactor is a lift, not a rewrite.
- **TDD guard = the existing suite is the spec.** This is behavior-preserving, so RED/GREEN is:
  the full existing provision suite (`provision-pipeline`, `provision-hostname`, `provision-sweep`,
  `lifecycle`, `deferred-provision`) stays green throughout. T2 ADDS focused unit tests that call a
  couple of the newly-extracted step functions in isolation — proving the testability the refactor
  unlocks (the extensibility payoff), not re-testing the whole pipeline.

## What's healthy (leave it)

## What's healthy (leave it)

- **`substrate/` (1,155 LOC)** — a clean `SubstrateProvider` contract with `RailwaySubstrate` +
  `FakeSubstrate` implementations. This is the *good* version of the seam PRD 02 wants for email.
- **`images/` (1,114 LOC)** — a clean image-store seam (`DockerImageStore` + `FakeImageStore`,
  `ExecFn` as the injection point).

Both are well-factored provider seams with deterministic fakes. Do not touch.

## The real over-complexity: `runProvisionPipeline` is a ~740-line function

`src/pipeline/provision.ts` (1,470 LOC) exports a single `runProvisionPipeline` spanning lines
541→1285 — the provisioning god-function. Tells:
- A `PROVISION_STEPS` const already names the sequence at the top of the file, so the pipeline is
  *conceptually* a list of named steps but *implemented* as one long procedure.
- Hard to test a single step in isolation; hard to add/reorder a step; hard to reason about failure/
  resume (the `provision-sweep` "finishes what Railway interrupted" — resume logic is entangled).

**Distillation direction (future build):** make each `PROVISION_STEP` a real unit — a small function
with typed input/output and its own test — driven by the `PROVISION_STEPS` list, so provisioning
becomes "run these steps" instead of a 740-line procedure. Behavior-preserving; the step list already
exists as the spine. This also clarifies resume (`provision-sweep`) — a step-addressable pipeline
resumes at a named step.

## To assess before scoping a build

1. **The four reconcile sweeps** (`reputation-sweep` 494, `alert-sweep` 348, `provision-sweep` 307,
   `build-sweep` 210). Each is a cron-style "reconcile desired vs actual" loop. Question: do they
   share enough structure (lease, scan-stale, act, record) to justify one `defineSweep` primitive,
   or are they genuinely distinct? Do NOT unify on a hunch — read all four first. Possibly they're
   fine as-is (four concerns, four files).
2. **The Sandbox build host** (`images/sandbox-exec.ts` 456 + `pipeline/build-host.ts` 157).
   `cloud-worker` has no Docker daemon, so image builds run on a Railway Sandbox. This looks like
   INHERENT complexity from a deliberate "build one image centrally, stamp N tenants from it" model
   (cheaper than N Railway source-builds). Confirm that rationale before considering alternatives
   (letting Railway build per-service via Nixpacks/Dockerfile would trade central-build-once for
   N-builds + per-tenant build variance). Likely NOT over-engineering — record the rationale so it
   stops looking like accidental complexity to the next reader.

## Deferred (NOT this wave)

1. **Sweep unification** — the four reconcile sweeps stay four files. Not touched; a separate future
   assessment (read all four before unifying, never on a hunch).
2. **Build host** — the build-once-deploy-N Sandbox model is inherent complexity; documented, left.

## EARS acceptance criteria

- WHEN `runProvisionPipeline({ stackId }, overrides?)` is called with any input the existing suite
  uses, the system SHALL produce byte-identical results (same `ProvisionResult`, same DB rows, same
  audit trail, same substrate calls) as before this PRD — proven by the full existing provision suite
  passing unchanged.
- WHEN `result.steps.map(s => s.step)` is read after a successful run, the system SHALL equal
  `[...PROVISION_STEPS]` (ordering + per-step reporting preserved).
- WHEN a `running` stack is re-enqueued, the system SHALL return `{ status: "running", steps: [] }`
  without running any step, transitioning status, or sending a welcome email (the `start`
  short-circuit).
- WHEN any step throws, the system SHALL park the stack via `StackService.recordError` with
  `last_error` prefixed `[<step>] …` and RETURN `{ status: "error", failedStep, error }` rather than
  throw (the caller contract the sweep and Hatchet task depend on).
- WHEN a previously-failed run is re-driven, the system SHALL skip every completed step on its
  persisted artifact (idempotency preserved) and report `skipped: true` for each.
- WHEN a newly-extracted step function is imported directly in a test, the system SHALL allow driving
  that single step against a `RunState` + `FakeSubstrate` without running the whole pipeline (the
  testability the refactor unlocks).
- WHEN `pnpm --filter @hogsend/cloud check-types` / `test` / `build` run, the system SHALL pass.

## Task breakdown

- **T1 — Extract the 11 step blocks into `RunState`-driven step functions + a driver.** Introduce
  `RunState` + `StepFn` type + `STEP_FNS: Record<ProvisionStep, StepFn>`; lift each `// ---- step ----`
  block out verbatim (idempotency/skip/audit unchanged); rewrite `runProvisionPipeline` as the driver
  keeping the single try/catch, the `start` short-circuit flag, and the outside-try welcome send.
  Preserve every public export signature. _Boundary:_ `apps/cloud`. _Depends:_ none. _Guard:_ full
  existing provision suite green.
- **T2 — Prove the seam with isolated step tests.** Add a small `provision-steps.test.ts` (app tests)
  that constructs a `RunState` and drives 2–3 individual step functions directly against
  `FakeSubstrate` — e.g. `stepMintHatchet` reuses a persisted token (skipped: true) vs mints one,
  `stepEnsureTenantDb` reuses an encrypted DSN. Demonstrates add/reorder/test-in-isolation is now
  cheap. _Boundary:_ `apps/cloud`. _Depends:_ T1.

## Done when

All EARS criteria pass; full app gates green; the existing provision suite unchanged and green; T2's
isolated step tests green; one commit per task; `## Implementation Notes` filled.

## Implementation Notes

**SHIPPED — T1** (commit `b0bea973`). The ~420-line `runProvisionPipeline` try-block is now a
list-driven pipeline:

- `interface RunState` holds the values formerly threaded as try-block locals (`stack`, `context`,
  `tenantDsn`, `poolMax`, `hatchetToken`, `hatchetHostPort`, `namespace`, `refs`, `engineVersion`,
  `secrets`, `sesTenant`, `steps`, `shortCircuit?`, `welcome?`). Mid-run fields are optional; the
  linear driver guarantees producer-before-consumer, and consumption sites narrow with `as` (13
  sites) rather than fabricating placeholder values — an honest cast, not a runtime guard that never
  fires.
- Each of the 11 `PROVISION_STEPS` is now `async function step<Name>(state, deps)`, lifted verbatim
  (idempotency/skip/persisted-artifact short-circuits + audit payloads unchanged). `auditStep(...)` is
  the former in-closure `audit`, now a module function.
- `const STEP_FNS: Record<ProvisionStep, StepFn>` — the `Record` type makes a missing/misspelled step
  key a COMPILE error. `runProvisionPipeline` is a driver: `for (const step of PROVISION_STEPS) {
  current = step; await STEP_FNS[step](state, deps); if (state.shortCircuit) return running }`, with
  the single try/catch→`recordError('[${current}] …')` and the outside-try welcome send preserved.
- **Sharp edges preserved:** `start` sets `state.shortCircuit` (no throw) so an already-`running`
  stack returns `{ status: "running", steps: [] }` with no finish/welcome; `stepStart` still audits
  `from: context.stack.status` (the loaded status). `finish` only sets `state.welcome`; the send
  stays outside the try so its throw can't re-enter `recordError` on a non-failable `running` status.
- **Every public export signature unchanged** — no caller edited (`git diff --stat` = provision.ts
  only). Verified independently by the orchestrator: provision suite 65/65, `check-types` ✓, Biome ✓,
  `build` ✓. Three-lens adversarial verify (value-threading, sharp-edges, export-compat) found zero
  confirmed issues.

**T2 — DESCOPED (behavior-preserving, lean-first).** The plan proposed isolated per-step unit tests
importing the step functions directly. On implementation this proved low-value AND surface-widening:
each step reads several `state.X` fields set by UPSTREAM steps, so "driving one step in isolation"
means hand-reconstructing the whole mid-run `RunState` (and exporting the step fns + `loadContext`
purely for tests). The extensibility contract that actually matters — the driver is list-driven with
NO hardcoded step knowledge, so add/remove/reorder is edit-`PROVISION_STEPS`-plus-`STEP_FNS` — is
already pinned by the existing suite: `provision-pipeline.test.ts` asserts
`result.steps.map(s => s.step) === [...PROVISION_STEPS]`, the per-step idempotency/skip cases, and the
failed-then-resumed paths. Adding redundant isolation tests + internal exports is the "adding
machinery" anti-pattern the DECISIONS lean-first rule warns against, so T2 is closed as unnecessary
rather than built.

**Deferred (unchanged from plan):** sweep unification (read all four first) and the build-host
rationale doc — neither is over-complexity this wave needed to touch.
