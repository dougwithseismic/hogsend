# Journey IR — Feasibility Verdict + Design

Status: proposed (feasibility-confirmed) · Engine line: 0.34.0 · Owner: Doug · Author: lead eng
Companion to `studio-agent-build-plan.md` — this is the **foundation layer** that turns the agent's authoring tier from "mostly opens PRs" into "mostly writes data."

> Synthesized from the `journey-ir-feasibility-design` workflow (3 feasibility agents completed; the design/verdict fan-out was cut off by a session limit, so this doc is hand-synthesized from the verified feasibility findings).

---

## 1. Verdict

**Feasible — with one load-bearing caveat.** The architecture is already *proven inside Hogsend by buckets*: a fluent builder that resolves once to a JSON tree which a generic evaluator walks at runtime. Every journey step maps 1:1 to an existing replay-safe `JourneyContext` primitive, so the **only genuinely new engine code is a tree-walking dispatcher**; persistence, idempotency, and lifecycle are reused unchanged. The one caveat is **in-flight versioning** — if a journey's JSON changes while users are mid-journey, a naive interpreter that re-reads the *current* tree on replay hits Temporal-style non-determinism; the fix is standard (pin each run to the IR snapshot it started on, Trigger.dev's model) and cheap.

Decision it unlocks: **declarative journeys/buckets/emails become runtime DATA** (create/edit live, no deploy, dev *and* prod), while the imperative TypeScript path stays first-class for the complex tail. Same tree, two faces.

---

## 2. The core idea

Buckets already do the thing we want for journeys:

- `criteriaBuilder` (a fluent TS API) **runs once at definition time and returns a plain `ConditionEval` JSON POJO** — byte-identical to the declarative form (`packages/core/src/conditions/builder.ts`, used in `define-bucket.ts:89`).
- A **generic** `evaluateCondition()` (`packages/core/src/conditions/evaluate.ts`) tree-walks that JSON at runtime — pure dispatch over a union type, no closures, no per-author code.

Journeys don't have this. `defineJourney({ meta, run })` compiles an imperative `run` function straight into a Hatchet `durableTask`. There is no JSON form and no generic interpreter.

**The plan:** give journeys the same dual nature.
1. A **Journey IR** — a JSON step tree (the analog of `ConditionEval`).
2. A fluent **journey builder** that resolves byte-identically to that IR (the analog of `criteriaBuilder`).
3. **One generic tree-walking interpreter** Hatchet task that walks the IR, mapping each node to an existing `JourneyContext` primitive.
4. A **DB-backed registry** (`journey_defs`) so a journey can live as a data row, not only as code.

The same tree is **TypeScript when you want code, JSON when you want runtime.** Coders write the builder; tweakers (and the agent) edit JSON live; anyone can "eject" JSON → `.ts` for git.

---

## 3. The Journey IR (node → primitive)

Every node maps to a verified existing primitive (`packages/engine/src/journeys/journey-context.ts`). **No gaps were found.**

| IR node | Backing primitive | Notes |
|---|---|---|
| `send` | `ctx.trigger()` (→ engine mailer) | exactly-once via auto-derived idempotency key |
| `sleep` | `ctx.sleep({ duration, label })` | durable; `label` = the node's `ref` |
| `sleepUntil` | `ctx.sleepUntil(Date, { label })` | `when`-spec pre-resolved to a Date at walk time via `ctx.when` |
| `waitForEvent` | `ctx.waitForEvent({ event, timeout, where, label })` | `where` reuses `ConditionEval`/`PropertyCondition[]` |
| `branch` | `evaluateCondition(cond, ctx)` + if/else | **same generic evaluator buckets use**; `cond` is a `ConditionEval` POJO in the node |
| `enroll` | `ctx.trigger({ event })` matching another journey's trigger | nested journeys need no special node |
| `trigger` | `ctx.trigger({ event, properties })` | cross-journey / cross-bucket fan-out |
| `checkpoint` | `ctx.checkpoint(label)` | observability; updates `currentNodeId` |
| `exit` | throw `JourneyExitedError` | clean terminal abort, no post-side-effects |
| `guard` | `ctx.guard.isSubscribed()` | re-check subscription after long waits |

**Zod shape (sketch):**
```ts
// Each node carries a STABLE author-time `ref` (the Inngest "content id, never positional" invariant).
const RefField = z.string().min(1); // unique within a journey; used as the durable/idempotency label

type IRNode =
  | { type: "send"; ref: string; template: string; props?: Json }
  | { type: "sleep"; ref: string; duration: DurationObject }
  | { type: "sleepUntil"; ref: string; when: WhenSpec }            // structured, resolved via ctx.when
  | { type: "waitForEvent"; ref: string; event: string; timeout: DurationObject; where?: ConditionEval; lookback?: DurationObject }
  | { type: "branch"; ref: string; if: ConditionEval; then: IRNode[]; else?: IRNode[] }
  | { type: "enroll"; ref: string; journeyId: string }
  | { type: "trigger"; ref: string; event: string; properties?: Json }
  | { type: "checkpoint"; ref: string; label: string }
  | { type: "guard"; ref: string; require: "subscribed"; else: "exit" | "continue" }
  | { type: "exit"; ref: string; reason?: string };

const JourneyIR = z.object({
  schemaVersion: z.literal(1),
  meta: z.object({
    id: z.string(),
    name: z.string(),
    enabled: z.boolean().default(true),
    trigger: z.object({ event: z.string(), where: ConditionEvalSchema.optional() }),
    entryLimit: z.enum(["once", "once_per_period", "unlimited"]).default("once"),
    entryPeriod: DurationSchema.optional(),
    suppress: DurationSchema.optional(),
    exitOn: z.array(z.object({ event: z.string(), where: ConditionEvalSchema.optional() })).optional(),
  }),
  steps: z.array(IRNodeSchema),
});
```

**The validation gate is Zod, not `tsc`.** The agent (or a human) emits an IR object; we `JourneyIR.parse()` it. That is dramatically safer and faster than typechecking arbitrary generated TypeScript — malformed structure is rejected at the door.

---

## 4. The interpreter

One generic Hatchet `durableTask` (`db-journey-interpreter`) that:

1. Receives `{ journeyId, version, userId, event, properties }`.
2. Loads the **pinned IR snapshot** for `version` (not "current" — see §6).
3. Creates/recovers the `journeyStates` row (reusing `define-journey.ts`'s `hatchetRunId`-keyed recovery + active-state guard).
4. Runs inside `runWithJourneyBoundary` (so `deriveJourneyKey`/`registerKey`/`memoize` work identically to hand-written journeys).
5. **Walks `steps`** with a dispatcher:

```ts
async function walk(nodes: IRNode[], ctx: JourneyContext, user: JourneyUser) {
  for (const node of nodes) {
    switch (node.type) {
      case "send":         await ctx.trigger({ event: sendEventFor(node.template), userId: user.id,
                                               properties: node.props, idempotencyLabel: node.ref }); break;
      case "sleep":        await ctx.sleep({ duration: node.duration, label: node.ref }); break;
      case "sleepUntil":   await ctx.sleepUntil(resolveWhen(node.when, ctx), { label: node.ref }); break;
      case "waitForEvent": { const r = await ctx.waitForEvent({ ...node, label: node.ref });
                             /* bind r.timedOut / r.properties for later branches via ctx scope */ break; }
      case "branch":       await walk(evaluateCondition(node.if, condCtx(ctx, user)) ? node.then : (node.else ?? []), ctx, user); break;
      case "enroll":       await ctx.trigger({ event: triggerEventFor(node.journeyId), userId: user.id, idempotencyLabel: node.ref }); break;
      case "trigger":      await ctx.trigger({ event: node.event, userId: user.id, properties: node.properties, idempotencyLabel: node.ref }); break;
      case "checkpoint":   ctx.checkpoint(node.label); break;
      case "guard":        if (!(await ctx.guard.isSubscribed()) && node.else === "exit") throw new JourneyExitedError(); break;
      case "exit":         throw new JourneyExitedError();
    }
  }
}
```

**Replay-safety — the crux (and it's already solved):**
- Hogsend keys every durable side-effect by `deriveJourneyKey({ anchor: runAnchor, site, discriminant })` where `runAnchor` is the replay-stable Hatchet run id and `site` is the nearest authored label (`journey-boundary.ts:145`).
- **The IR node's `ref` IS the `site`/`idempotencyLabel`.** Because `ref` is author-assigned and stable (never the array index), a replay that reaches the same node re-derives the same key → Layer-1 memo + Layer-2 unique-index dedup fire exactly as they do for hand-written journeys. **Zero persistence changes.**
- Determinism rules baked in: no `Date.now`/random in the walk (use `ctx.now()`); branch decisions come from `evaluateCondition` over stable inputs; any nondeterminism wraps in `ctx.once`.

**Lifecycle parity:** the interpreter reuses `enterWait`/`resumeFromWait`, `TERMINAL_STATUSES`, `JourneyExitedError`, and the completed/failed push of `journey:completed`/`journey:failed` — same as `define-journey.ts`. Code journeys and IR journeys coexist in the same worker untouched.

---

## 5. Routing & registry

**The constraint:** Hatchet `onEvents` is static at worker boot, and event payloads carry no `journeyId`. So you cannot register "one task for all future runtime journeys" directly.

**The solution (dispatch-at-ingest — verified as the right hook):**
1. Add a `journey_defs` table (engine-track migration): `id, version, ir jsonb, triggerEvent (indexed), triggerWhere jsonb, enabled, criteriaHash, name, timestamps`.
2. In `ingestEvent()` (`lib/ingestion.ts`), after the existing `checkExits()`/`checkBucketMembership()` steps, add `checkDbJourneys()`:
   ```ts
   const matches = await db.query.journeyDefs.findMany({
     where: and(eq(journeyDefs.triggerEvent, event.event), eq(journeyDefs.enabled, true)),
   });
   for (const def of matches) {
     if (def.triggerWhere && !evaluateCondition(def.triggerWhere, condCtx)) continue; // entry guard
     await hatchet.events.push("journey:run", { journeyId: def.id, version: def.version, userId, userEmail, properties });
   }
   ```
3. Register **one** generic task: `hatchet.durableTask({ name: "db-journey-interpreter", onEvents: ["journey:run"], fn: interpretJourneyIR })`.

**Result:** a new runtime journey is a `journey_defs` INSERT. No worker restart, no new Hatchet registration. Enable/disable is the `enabled` flag, checked at ingest. Cost: one extra indexed query per ingested event (mitigated by the `(triggerEvent, enabled)` index).

**Merged registry:** extend `JourneyRegistry` (which already indexes by id + trigger event) so `GET /v1/admin/journeys` lists code journeys *and* DB journeys uniformly. Collision policy: **DB journeys use UUIDs / a `db:` id prefix** so they can never shadow a code journey id.

---

## 6. In-flight versioning (the one real hazard)

If a journey's IR is edited while users are mid-flight and the interpreter re-reads the *current* IR on replay, you get the equivalent of editing a Temporal workflow under a running execution — a wait/branch that no longer exists, a timer whose duration changed → wedged runs.

**Fix (Trigger.dev's model, copied verbatim):**
- `journey_defs` rows are **append-only versioned snapshots** (or a `journey_def_versions` table). Editing a journey writes a new `version`.
- When a `journeyStates` row is created, **stamp it with the IR `version`** and the interpreter loads *that* snapshot for the life of the run.
- New enrollments use the latest version; **in-flight users finish on the version they started on.**
- "Re-run this contact on the latest journey" is a deliberate, separate action (Trigger.dev's "replay"), never an automatic swap.

Belt-and-braces: keep keys content/`ref`-derived (Inngest rule — already true), so even within a version, reordering siblings doesn't corrupt dedup.

---

## 7. Round-trip codegen — "can we generate the TypeScript from the JSON?"

**Yes. Both directions. This is the keystone.**

- **TS → IR:** the fluent journey builder resolves once to the IR (exactly as `criteriaBuilder` resolves to `ConditionEval`). So code-authored journeys already *are* IR internally — they show up in the visual/JSON editor for free.
- **IR → TS:** a pretty-printer walks the IR and emits canonical builder TypeScript. So a journey tweaked live as JSON can be **"ejected to code"** — dropped into `apps/api/src/journeys/<id>.ts` for git review.

```ts
// Builder (what a dev writes — resolves byte-identically to the IR above)
export const winback = defineJourneyIR({
  meta: { id: "winback", trigger: { event: "trial.expired" }, entryLimit: "once" },
  steps: (j) =>
    j.send("winback-1")
     .sleep(days(3))
     .waitForEvent("checkout.completed", { timeout: days(7) })
     .branch((b) => b.timedOut(),
        (t) => t.send("winback-2"),
        (e) => e.exit()),
});

// IR -> TS pretty-print (eject): the JSON tree above renders back to this exact builder source.
```

The builder is sugar; the IR is the source of truth the runtime executes. Neither is "the real one" — they're two serializations of the same tree.

---

## 8. The 80/20 boundary + coexistence

**IR covers (the declarative ~80%):** triggered send, multi-step sequences, `sleep`/`sleepUntil`/send-windows, `waitForEvent`+timeout, `branch` on any `ConditionEval`, `enroll`, `trigger`, `guard`, `exit`, plus all meta (entryLimit/suppress/exitOn).

**Still needs imperative `run()` (the ~20%):** external API calls mid-journey, arbitrary compute, LLM/RNG decisions (`ctx.once`), dynamic/unbounded loops. These stay code-first — *because they genuinely are code* — and ship via dev-hot-reload + PR.

**Coexistence:** purely additive. Existing `defineJourney` journeys are untouched and keep their own Hatchet tasks. An existing imperative journey that turns out to be fully declarative can be *optionally* downgraded to IR via a one-time codegen — never forced. Bound the DSL (no arbitrary code/recursion in the tree; reuse the condition language) so we don't drift into a hard-to-debug general interpreter — the industry "workflow should be code" lesson; the TS path is the escape hatch.

---

## 9. How this rewrites the agent plan

In `studio-agent-build-plan.md`, these capability-matrix rows flip:

| Capability | Before (code-gen plan) | After (with Journey IR) |
|---|---|---|
| Write a journey (declarative) | authoring → **prod-via-PR** | **runtime data, no PR** (dev + prod) |
| Create a bucket | authoring → PR / hot-reload | **runtime data** (DB bucket_def) |
| Create/edit an email (simple) | authoring → prod-via-PR | **runtime data** (block-template store) |
| A non-coder "little tweak" | clone+edit+PR+deploy | **edit JSON in Studio, instant** |
| Complex journey (imperative) | prod-via-PR | unchanged — prod-via-PR (correct) |

The agent's authoring tier shrinks to: **emit a Zod-validated IR object (safe, runtime)** for the common case, and **generate TypeScript + PR** only for the imperative tail. The dangerous "write arbitrary TS, typecheck it, hope it compiles" path becomes the exception, not the rule.

---

## 10. Parallel wins (same idea, easier)

- **Buckets** already store `ConditionEval` criteria — the *only* missing piece is a DB-backed `bucket_def` the reconcile/registry also reads (today reconcile loops the code registry via `registry.getEnabled()`). Smallest lift; do it first as the proof.
- **Emails** — a DB **block-template** (JSON block model) rendered through the existing `renderToHtml` + tracking pipeline. Code React templates stay for power users; the block store gives runtime create/edit with zero deploy.

Journeys are the hard one (durable execution); buckets and emails are the quick confidence-builders.

---

## 11. Build plan

| Phase | Scope | Acceptance | Effort |
|---|---|---|---|
| **IR-0** Bucket DB-defs (warm-up) | `bucket_defs` table; registry/reconcile read code + DB buckets; admin write route | A bucket created via API materializes members on next reconcile, no deploy | ~3-4d |
| **IR-1** IR schema + builder + Zod | `JourneyIR` Zod schema; fluent builder resolving to IR; `defineJourneyIR` | round-trip: builder → IR → `JourneyIR.parse` passes; golden tests | ~3d |
| **IR-2** Interpreter + replay tests | `db-journey-interpreter` durableTask; node dispatcher; `ref`-as-label keying | a 4-step IR journey runs end-to-end; **replay/crash test proves exactly-once sends** | ~5d |
| **IR-3** Routing + `journey_defs` + registry merge | migration; `checkDbJourneys()` ingest hook; merged registry; admin CRUD | runtime INSERT → next matching event runs the journey, no restart | ~4d |
| **IR-4** In-flight versioning | versioned snapshots; `journeyStates.defVersion` pin; "replay on latest" action | edit a journey mid-flight; in-flight users finish on old version, new users get new | ~3d |
| **IR-5** Round-trip codegen | IR → builder-TS pretty-printer; "eject to code" Studio action | a runtime journey ejects to a valid `.ts` that typechecks + re-imports to identical IR | ~3d |
| **IR-6** Agent emits IR | agent authoring tier emits Zod-validated IR for declarative content; PR path only for imperative | agent builds a working runtime journey from NL with no PR | folds into agent Phase 3 |
| **IR-7** Email block-templates | `email_defs` block store + render integration | runtime create/edit of an email, sent through tracking pipeline | ~4d |

**Sequencing vs the agent plan:** IR-0 (buckets) can run alongside the agent's operate-tier (Phases 0-2). The journey IR (IR-1→IR-5) is the foundation for the agent's *authoring* tier (agent Phase 3) — build it before, or in lockstep with, that phase so the agent targets IR, not arbitrary code-gen, from day one.

---

## 12. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **In-flight versioning** (IR changes under running journeys) | Pin each `journeyStates` to its IR snapshot version (Trigger.dev); new users get new version, in-flight finish on old; "replay on latest" is explicit |
| **Positional keys break dedup on reorder** | Author-assigned stable `ref` per node = the durable/idempotency label (Inngest rule); Hogsend already keys by label, not index |
| **Interpreter non-determinism on replay** | No `Date.now`/random in the walk; branches from `evaluateCondition` over stable inputs; `ctx.once` for any nondeterminism |
| **Ingest latency** (DB query per event for `journey_defs`) | Index `(triggerEvent, enabled)`; only declarative journeys incur it; cache hot defs in-process with short TTL if needed |
| **DSL over-reach** (becomes a hard-to-debug general interpreter) | Bound the IR (no arbitrary code/recursion; reuse condition language); keep TS `run()` as the escape hatch for the 20% |
| **id collision** (code journey vs DB journey) | DB journeys use UUID / `db:` prefix; registry rejects collisions at merge |
| **Orphaned `journeyStates`** when a DB journey is deleted | Soft-delete `journey_defs`; interpreter treats missing/deleted def as a clean exit |

---

## 13. Open decisions for Doug

1. **Build order:** IR layer as the *foundation first* (my recommendation — it's what makes the agent "write data not PRs"), or ship the operate-only agent first and add IR after? Recommendation: **operate-tier agent + IR-0 (buckets) in parallel now; journey IR before the agent's authoring tier.**
2. **Node id scheme:** explicit author-assigned `ref` (Knock-style, my recommendation) vs hash-of-config (Inngest-style). `ref` is more edit-tolerant and human-readable.
3. **Buckets/emails before or after journey IR?** Recommendation: **buckets first** (smallest lift, proves the DB-def + merged-registry pattern), journeys next, emails after.
4. **Versioning storage:** append-only `journey_defs` rows vs a separate `journey_def_versions` table. Recommendation: separate versions table (clean "current vs history" + the `journeyStates.defVersion` FK).
5. **How much IR surface in v1?** Recommendation: ship `send`/`sleep`/`sleepUntil`/`waitForEvent`/`branch`/`exit` first (covers most lifecycle email), add `enroll`/`trigger`/`guard` in a fast follow.
