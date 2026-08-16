# PRD 04 — Railway provisioning plane distillation (PLAN ONLY — no code this run)

> **Status: design/scoping only.** The second pillar of `apps/cloud` — the control plane that builds
> a per-tenant image and provisions each customer their own Hogsend instance on Railway. Captured so
> the distillation lens isn't email-only. No code this run.

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

## Decisions needed before a build wave

1. Is `runProvisionPipeline` step-extraction worth a build wave now, or lower priority than the email
   pillar? (Recommendation: yes eventually — it's the single highest-complexity file in the plane —
   but after the email diagnostics land.)
2. Sweeps: unify or leave? (Decide only after reading all four.)
3. Build host: confirm build-once-deploy-N rationale; document it; likely close as "inherent."

## EARS acceptance criteria (for THIS plan-only PRD)

- WHEN reviewed, the doc SHALL name the healthy seams (leave), the `runProvisionPipeline` god-function
  (distill via `PROVISION_STEPS`), and the two open assessments (sweeps, build host).
- WHEN approved, NO provisioning code changes are attributable to this PRD (plan only).

## Task breakdown

- **T1 — (this run) Capture this assessment.** _Boundary:_ `docs/`. _Depends:_ none.
- **T2..Tn — (future wave)** step-extraction of `runProvisionPipeline` (one commit per extracted step
  cluster, `FakeSubstrate` gives deterministic tests); sweep read + decision; build-host rationale
  doc.

## Done when

Reviewed; the three decisions surfaced. No code.

## Implementation Notes

_(filled if/when promoted to a build wave)_
