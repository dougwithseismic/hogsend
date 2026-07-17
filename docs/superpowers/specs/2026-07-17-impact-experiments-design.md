# Impact experiments — final design spec

## Problem & product sentence

Hogsend can enroll, send, and record conversions, but it cannot answer the question the operator actually asks: **"You added this journey / shipped this change — and here's what happened to the numbers."** The change→outcome loop is open: version boundaries are invisible, per-journey holdout lift has a route but no consumer, A/B splits inside a journey have no primitive, and nothing proactive tells the operator when a number moved.

This spec closes the loop with six coordinated pieces: version stamping on every enrollment (Decision A), a deterministic recorded `ctx.variant` primitive (Decision B), a boot-validated `meta.goal` binding (Decision C), two admin readout routes plus Studio surfaces (Decision D), a weekly `impact.digest` outbound event (Decision E), and dogfood adoption with one consolidated docs pass (Decision F). Causal language is reserved for holdout-backed numbers; everything else is labeled observational.

## What already exists (brief)

- **Per-journey holdout**: `JourneyMeta.holdout {percent 0–50, salt?}`; deterministic sha256 bucketing in `packages/engine/src/lib/holdout.ts` (`holdoutBucket`, `isHeldOut`, `globalControlPercent`, `isGlobalControl`). No RNG, no clock (the replay law). Diversion runs LAST in the enrollment guards (`packages/engine/src/journeys/execute-journey-run.ts:265-403`); held-out users get ONE `journey_states` row ever per (user, journey) with `status='held_out'` (prior-row check at `:330-339`), plus a `journey.heldout` spine event.
- **Lift math**: `packages/engine/src/lib/lift-stats.ts` — Bayesian beta-binomial `computeLift({treatment, control})` → `{liftPercent, winProbability, suppressed, smallSample}`; `MIN_COMBINED_CONVERSIONS=10`, `SMALL_SAMPLE_FLOOR=100`.
- **Lift route**: `GET /v1/admin/journeys/{id}/lift` (`packages/engine/src/routes/admin/journeys.ts:501-536` def, `:1114-1200` handler). No consumer exists.
- **Conversions**: `defineConversion(meta)` in `packages/core/src/conversions.ts`; fired instances in the `conversions` table; registered via `createHogsendClient({conversions})` with a seeded zero-config `revenue` definition (`container.ts:899-914`). Dogfood defines `deal-sold`, `deal-quoted`, `lead-submitted`.
- **Attribution**: `attribution_credits` ledger (model, weight, value, journeyId, campaignId); correlational readouts in `routes/admin/attribution.ts`.
- **`ctx.once` / recordOnce**: durable set-once into reserved `journey_states.context` sub-bags (`__once__|__digest__|__throttle__`), first-committed-writer-wins jsonb merge (`packages/engine/src/journeys/record-once.ts`). The substrate for per-user experiment state.
- **Global control**: `GLOBAL_CONTROL_PERCENT` env, assignment-only today — `isGlobalControl` suppresses sends in `lib/tracked.ts:246` / `lib/sms-tracked.ts:226`; no readout anywhere.
- **Outbound spine**: `lib/outbound.ts` `emitOutbound`; the webhook event catalog is vendored in `packages/cli/src/commands/webhooks.ts` and `packages/client/src/types.ts`, hand-synced with `WEBHOOK_EVENT_TYPES` in `lib/webhook-signing.ts`.
- **Cron pattern**: `onCrons: [process.env.<VAR> ?? "<default>"]` (`workflows/bucket-reconcile.ts:79-90`); `check-alerts.ts` supplies the self-bootstrap + exported-seam pattern (it has no cron of its own).
- **Studio**: observe-only Vite React SPA; admin client in `src/lib/admin-api.ts`; no lift view.
- **Causal-language law**: `routes/admin/funnels.ts:16` — only holdout output may use causal language.
- **Known latent bug this spec fixes**: `journeyMetaSchema` (`packages/core/src/schemas/journey.schema.ts:85-132`) omits `category` AND `holdout` today; `JourneyRegistry.register` zod-parses and strips unknown keys, so `registry.get(id).holdout` is `undefined` for every journey. Stamping/diversion is unaffected (task-closure meta), but any registry-reading readout would silently label every journey observational.

## Design

### D0. Coordinated `@hogsend/core` edit (phase 1a — blocks everything)

Three components collide on two core files; land them as ONE small PR with zero behavior change.

**`packages/core/src/types/journey.ts`** — `JourneyMeta` (`:42-105`) gains, after `holdout` and before the bucket-reaction block:

```ts
  /**
   * Optional human-readable version label (e.g. "v2-shorter-copy"). Stamped
   * verbatim onto every enrollment AND holdout row this definition creates
   * (journey_states.journey_version_label). DISPLAY-ONLY: readouts group
   * cohorts by versionHash (content truth); changing only this label never
   * forks a cohort. Free text, 1–64 chars. An out-of-bounds label first
   * fails inside JourneyRegistry.register's schema parse at container boot
   * (deploy fails loudly) — intended typo-catcher behavior.
   */
  version?: string;

  /**
   * Engine-computed content fingerprint: first 12 hex chars of sha256 over
   * the normalized run source + the behavior-bearing meta fields (see
   * computeJourneyVersionHash). Set by defineJourney for code journeys and
   * blueprintMetaFromRow for blueprints — NEVER authored; any input value
   * is overwritten. Optional only so hand-built test metas stay valid.
   */
  versionHash?: string;
```

and, after `category`:

```ts
  /**
   * The conversion this journey exists to move — a defineConversion id
   * (including the built-in zero-config "revenue" conversion when seeded).
   * Boot-validated fail-closed in createHogsendClient: an id that matches
   * no registered conversion definition throws with the known-id list.
   * The lift/impact routes use it as the default definitionId when the
   * caller passes none; an explicit query param always wins. Purely a
   * readout default — it never gates enrollment, sends, or conversion
   * firing. (The inverse, descriptive pointer is ConversionMeta.scope
   * .journeyId — the two are independent.)
   */
  goal?: string;
```

`JourneyMetaInput` (`:30-40`) must not accept the computed field:

```ts
export interface JourneyMetaInput
  extends Omit<JourneyMeta, "trigger" | "exitOn" | "versionHash"> {
```

(`version` and `goal` flow through `...rest` in `defineJourney` automatically.)

**`packages/core/src/schemas/journey.schema.ts`** — `journeyMetaSchema` (`:85-132`; the strip-warning comment at `:120-122`) declares ALL FIVE fields in one edit — the three new ones plus the two already-missing ones:

```ts
  /** Display-only version label; never part of the content hash. */
  version: z.string().min(1).max(64).optional(),
  /** Engine-computed content fingerprint (12 lowercase hex). */
  versionHash: z.string().regex(/^[0-9a-f]{12}$/).optional(),
  /** Conversion definition id the lift/impact readouts default to. */
  goal: z.string().min(1).optional(),
  category: z.string().optional(),
  /** Loose percent validation — lib/holdout.ts clamps 0-50 at evaluation;
   * a boot throw on a clamped-but-legal value would be a regression. */
  holdout: z
    .object({ percent: z.number(), salt: z.string().optional() })
    .optional(),
```

**`packages/core/src/types/journey-context.ts`** — `JourneyContext` (`:261-386`, alongside `once` at `:326`) gains:

```ts
/**
 * Deterministic experiment arm for THIS user — the replay-law-safe A/B
 * primitive. Assignment is a pure sha256 bucket over (journeyId, key,
 * userId): NO RNG, NO clock — the same user gets the same arm on every
 * evaluation and, while the arms array is unchanged, on every re-entry.
 * The assignment is additionally RECORDED once per enrollment
 * (journey_states.context __variants__ bag), and the recorded value wins
 * VERBATIM on any later call within that enrollment — including a replay
 * after a deploy that changed `arms`. A re-entry mints a NEW state row and
 * re-DERIVES the arm from the hash; editing the arms array between entries
 * may reassign re-entrants. Issues ZERO durable Hatchet calls
 * (positionally invisible in the journal, like ctx.throttle).
 *
 * Equal split only in v1 (weights deferred — see out of scope).
 *
 * Holdout diverts BEFORE run() executes, so variants split the TREATMENT
 * cohort only; per-variant lift is each variant vs the whole held-out
 * cohort.
 *
 * A variant-selected template needs NO ctx.once wrap and no
 * idempotencyLabel of its own: the arm is deterministic + recorded, so a
 * replay re-derives the identical send key. The pre-existing rule stands:
 * if a LATER unconditional send can hit the SAME template as one of the
 * arms under the same nearest wait label, give one of them a distinct
 * idempotencyLabel (the engine throws the loud key-collision error
 * otherwise).
 *
 * Runtime caveat: a recorded arm from an OLDER deploy may not be in the
 * current `arms` — it is returned verbatim (and warned once); the
 * literal-union return type is best-effort, same accepted unsoundness
 * class as ctx.once<T>.
 */
variant<const A extends readonly [string, ...string[]]>(
  key: string,
  arms: A,
): Promise<A[number]>;
```

Repo TS is 5.9.2, so `const` type parameters infer `Promise<"a" | "b">` with no `as const`.

**Test**: registry round-trip test in `packages/core/src/registry/index.test.ts` covering all five fields (`register` retains `version`/`versionHash`/`goal`/`category`/`holdout`; invalid `versionHash` format rejected; empty-string `goal` rejected; 65-char `version` rejected).

Independently shippable; nothing reads the new fields yet.

### D1. Version stamping (Decision A)

Every `journey_states` row records WHICH content-version of the journey created it: `journey_version_hash` (truth) plus `journey_version_label` (display). Held-out rows are stamped too — a control cohort is only comparable to the treatment cohort of the same version window. Blueprint enrollments stamp a graph-content hash with `v{row.version}` as the label.

**Hash computation — NEW `packages/engine/src/journeys/journey-version.ts`.** Engine, not core: it needs `node:crypto` (precedent `lib/holdout.ts:1`). NO acorn — acorn is declared in engine package.json but imported nowhere in `packages/engine/src`; a new runtime npm import would trip the consumer-bundling dep-mirroring trap. A dependency-free scanner suffices.

```ts
import { createHash } from "node:crypto";
import type { JourneyMeta } from "@hogsend/core/types";
import { stableStringify } from "../lib/stable-stringify.js";

/**
 * Bump when normalization/hash-input rules change. Forks every hash exactly
 * once on upgrade (a global, labeled refork — honest and self-documenting).
 */
const HASH_INPUT_VERSION = "hsv1";

/**
 * Deterministic, dependency-free normalization of a Function.prototype
 * .toString() capture, so formatting- and comment-only edits do not fork a
 * version cohort:
 *  1. strip // line and block comments with a string-aware single-pass
 *     scanner (states: code | single | double | template | lineComment |
 *     blockComment; a \ inside any string state consumes the next char;
 *     each stripped comment is replaced by one space),
 *  2. collapse every whitespace run to a single space, trim.
 * KNOWN LIMITS (documented, deterministic): (a) a // inside a regex literal
 * is misread as a comment start and mangles the rest of that line; (b) the
 * scanner exits `template` state at the first backtick, so a nested
 * template or a string/comment inside ${...} is misclassified. In both
 * cases the output is still a pure function of the input, so the hash
 * stays stable — the only cost is fork-detection fidelity on those lines.
 * Never throws; empty input → "".
 */
export function normalizeRunSource(source: string): string;

/**
 * Content fingerprint of one journey version: sha256, first 12 hex chars
 * (48 bits — per-journey version counts are tiny; collision negligible).
 * Input = HASH_INPUT_VERSION + "\n" + normalizeRunSource(body ?? "") + "\n"
 * + stableStringify(hashable meta).
 *
 * Hashable meta = the meta MINUS `enabled` (toggling — including the
 * journey_configs admin override — is not a content change), `version`
 * (display label), `versionHash` (self), `name`, `description` (display
 * only; DECIDED excluded — display fields don't fork cohorts; this
 * exclusion list is frozen at first release, since changing it later
 * reforks every journey once). Everything else is included BY DEFAULT via
 * rest-destructuring — id, trigger, entryLimit, entryPeriod, exitOn,
 * category, suppress, holdout, goal, sourceBucketId, reactionKind,
 * dwellSchedule, and any FUTURE meta field — because missing a real
 * behavior change is worse than a spurious fork.
 *
 * For blueprints, `body` is stableStringify(row.graph), which ALSO passes
 * through normalizeRunSource. Safe: stableStringify emits no whitespace or
 * comments outside JSON strings, and // inside double-quoted string values
 * (URLs in graph node config) is protected by the string-aware scanner,
 * including \" escapes.
 */
export function computeJourneyVersionHash(opts: {
  meta: JourneyMeta;
  /** runSource for code journeys; stableStringify(graph) for blueprints. */
  body?: string;
}): string {
  const {
    enabled: _e, version: _v, versionHash: _h,
    name: _n, description: _d,
    ...hashable
  } = opts.meta;
  return createHash("sha256")
    .update(
      `${HASH_INPUT_VERSION}\n${opts.body ? normalizeRunSource(opts.body) : ""}\n${stableStringify(hashable)}`,
    )
    .digest("hex")
    .slice(0, 12);
}
```

Determinism notes: `where` builder fns are resolved ONCE into POJOs by `normalizeWhere` at defineJourney time (`define-journey.ts:127,:137`) — the hashed meta is canonical data, never a function. `stableStringify` sorts keys and drops `undefined`, so key order and optional-field spreading cannot churn the hash. No RNG, no clock.

**Hoist `stableStringify` — NEW `packages/engine/src/lib/stable-stringify.ts`.** Move the implementation verbatim from `workflows/bucket-backfill.ts:53-65`; point `computeCriteriaHash` (`:45-51`) at the import. Byte-identical algorithm ⇒ `bucket_configs.criteriaHash` unchanged (no re-eval storm on boot).

**Accepted hash churn across build modes.** `runSource` is captured from the running artifact (`define-journey.ts:46-52,:124`): tsx dev output ≠ consumer tsup bundle; esbuild identifier aliasing and toolchain-bump emit drift can fork a prod cohort once with zero content change. Accepted: forks are append-only cohort noise; labels give continuity. All readout/digest consumers MUST treat a new hash as "possible new version", not proof of change. Documented verbatim in the JSDoc.

**Template edits are NOT in the hash.** Email template components in `src/emails/*.tsx` are referenced by registry key; rewriting template copy forks no cohort. Minimum honest v1: this fact is stated everywhere the hash is explained (JSDoc + docs, D7), AND the digest treats a version-LABEL change as a first-class shipped signal (D5, `change: "new_label"`) so the documented operator practice — bump the label when you rework a template — produces the "shipped" moment. Real fix (follow-up, out of scope): fold a hash of the rendered template registry into the hash body input.

**`defineJourney` (`packages/engine/src/journeys/define-journey.ts:120-145`)**: build the normalized meta as today, then attach:

```ts
  const meta: JourneyMeta = {
    ...normalized,
    versionHash: computeJourneyVersionHash({ meta: normalized, body: runSource }),
  };
```

Both the eager task path and the lazy authoring-subpath getter close over this same `meta` — the task's `executeJourneyRun` sees the hash with zero further plumbing. Export `computeJourneyVersionHash` and `normalizeRunSource` from `packages/engine/src/index.ts` (near `:216`).

**DB — `packages/db/src/schema/journey-states.ts`**, after `hatchetRunId` (`:25`):

```ts
    /**
     * Impact experiments (Decision A): content fingerprint of the journey
     * DEFINITION this row was created under — stamped at INSERT on both
     * the enrollment and held_out paths, NEVER updated (a replay/resume
     * recovers the row and must keep the entry-time version). Nullable:
     * rows predating the feature form the "unversioned" cohort.
     */
    journeyVersionHash: text("journey_version_hash"),
    /** Author label (JourneyMeta.version / blueprint v{n}). Display-only. */
    journeyVersionLabel: text("journey_version_label"),
```

Migration via `cd packages/db && pnpm db:generate` → `packages/db/drizzle/0060_*.sql` (engine track; journal currently ends at 0059), expected content exactly:

```sql
ALTER TABLE "journey_states" ADD COLUMN "journey_version_hash" text;
ALTER TABLE "journey_states" ADD COLUMN "journey_version_label" text;
```

Nullable, no default ⇒ metadata-only, no rewrite, no backfill. The client migration track is untouched. **Index decision (recorded deferral)**: phase 1 ships NO index — stamping alone needs none; existing `journey_states_journey_id_status_idx` covers the per-journey readouts. The digest phase (D5) owns adding `(journey_id, journey_version_hash)` in ITS migration if profiling of the weekly Detection A GROUP BY demands it.

**Stamping — `packages/engine/src/journeys/execute-journey-run.ts`.** Exactly THREE `insert(journeyStates)` sites exist in the repo (`:151`, `:161` inside `insertEnrollment`; `:340` held_out). All stamping happens at these inserts; no UPDATE path ever touches the version columns.

(a) `insertEnrollment` (`:118-167`) is a PUBLIC engine export used directly by dogfood tests — new opts are OPTIONAL (non-breaking), defaulting to null:

```ts
  /**
   * Content fingerprint + label of the definition this enrollment enters
   * under (meta.versionHash / meta.version). Stamped once here; never
   * updated. Optional for API back-compat; executeJourneyRun always passes.
   */
  journeyVersionHash?: string | null;
  journeyVersionLabel?: string | null;
```

with `values` gaining `journeyVersionHash: opts.journeyVersionHash ?? null` / `journeyVersionLabel: opts.journeyVersionLabel ?? null` — both lock-free and graph-locked branches share `values`; the `onConflictDoNothing` arbiter is untouched.

(b) enrollment call site (`:425-435`) and (c) held_out insert (`:339-350`) both add:

```ts
      journeyVersionHash: meta.versionHash ?? null,
      journeyVersionLabel: meta.version ?? null,
```

(d) Recovery never restamps — already guaranteed structurally: the replay-recovery `findFirst` by `(hatchetRunId, journeyId)` at `:249-256` runs BEFORE all guards; a recovered `state` makes the entire `if (!state)` block (`:265-439`) unreachable. The row keeps its ENTRY-time version while replay executes current code. Blueprint recovery's `failRecoveredBlueprintEnrollment` (`journey-blueprint-interpreter.ts:465-497`) updates `status`/`errorMessage` only — unchanged. Verified by test, not just prose.

**Blueprint path — `workflows/journey-blueprint-interpreter.ts`.** `blueprintMetaFromRow` (`:56-80`; the `triggerWhere` narrowing const at `:57-59` moves inside or above the extracted `base` object — it must be preserved):

```ts
export function blueprintMetaFromRow(row: JourneyBlueprintRow): JourneyMeta {
  const base: JourneyMeta = { /* existing object, unchanged */ };
  return {
    ...base,
    version: `v${row.version}`,
    versionHash: computeJourneyVersionHash({
      meta: base,
      body: stableStringify(row.graph),
    }),
  };
}
```

The run always executes the CURRENT graph and hashes that same current row, so the stamp reflects the content that ran. The existing `context.__blueprintVersion` dispatch-time pin stays untouched (different question). `stableStringify(row.graph)` is key-order-stable, so jsonb round-trip reordering cannot fork the hash.

**Admin exposure — `routes/admin/journeys.ts`.** `journeySchema` (`:37-55`) gains `version: z.string().optional()` and `versionHash: z.string().optional()`; list map (`:583-591`) and detail handler (`:648-668`) add both (detail reads registry meta — depends on the D0 schema fix). `stateSchema` (`:59-74`, shared with blueprint admin routes) gains `journeyVersionHash: z.string().nullable()` / `journeyVersionLabel: z.string().nullable()`; `serializeState` spreads `...row`, so the new columns flow into `recentStates` with zero handler changes.

**Semantics note for consumers**: held-out rows are once-ever per (user, journey), so control-cohort version stamps thin out over time (early divertees keep v1 stamps forever). The per-version lift readout matches control by SAME hash, not by date window (see D4), which is exactly why held_out rows carry the stamp.

### D2. `ctx.variant` (Decision B — equal split only)

**Pure assignment — NEW `packages/engine/src/lib/variant.ts`.** Mirrors `lib/holdout.ts` (node:crypto sha256, 0–9999 bucket, replay-law doc block).

```ts
import { createHash } from "node:crypto";

/** key charset: jsonb object key + hash segment + future API query param. */
const VARIANT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Uniform 0–9999 bucket. Hash input is `variant:<journeyId>:<key>:<userId>`
 * — the `variant:` prefix + the key segment make this hash family DISJOINT
 * from holdoutBucket's `<salt>:<journeyId>:<userId>` (holdout.ts:17), so
 * variant assignment is statistically independent of holdout assignment.
 * `key` cannot contain `:` (validated), so segments are unambiguous.
 * FROZEN COMPATIBILITY CONTRACT under the replay law — locked by a
 * golden-value test; changing it re-buckets live experiments mid-flight. */
export function variantBucket(opts: {
  journeyId: string;
  key: string;
  userId: string;
}): number {
  const digest = createHash("sha256")
    .update(`variant:${opts.journeyId}:${opts.key}:${opts.userId}`)
    .digest();
  return digest.readUInt32BE(0) % 10000;
}

/** Key-syntax-only check — runs BEFORE the recordOnce read (it gates the
 * jsonb path). Throws RangeError. */
export function validateVariantKey(key: string): void;

/** Arms validation — runs ONLY inside the compute path (see performVariant).
 * Throws RangeError on: zero arms (JS callers; TS blocks via the tuple),
 * empty/non-string arm, duplicate arms. */
export function validateVariantArms(arms: readonly string[]): void;

/** Deterministically pick one arm, equal split. Threshold for arm i is
 * Math.round(((i + 1) / arms.length) * 10000); the LAST arm is forced to
 * 10000 so rounding can never leave bucket 9999 unassigned. */
export function pickVariant(opts: {
  journeyId: string;
  key: string;
  userId: string;
  arms: readonly string[];
}): string;
```

Weighted arms are DEFERRED (out of scope): Decision B specified equal split; weights carry the only thorny semantics (a weight edit remaps buckets, so re-entrants of `unlimited`/`once_per_period` journeys switch arms and the readout's `count(distinct user_id) GROUP BY arm` would count one user in two arm cohorts). If weights ever ship, the variant readout must count per-enrollment or segment by `journeyVersionHash` (a weight edit changes the hash — the clean cut).

**Reserved namespace — `packages/engine/src/journeys/record-once.ts`.** `RecordNamespace` (`:8`) → `"__once__" | "__digest__" | "__throttle__" | "__variants__"`; `NAMESPACE_TOKEN` (`:13-17`) gains `__variants__: "__variants__"`. Grep-verified: zero existing `__variants__` uses. Stored shape: `journey_states.context.__variants__ = { "<key>": "<arm string>" }` — the bare arm string is the readout dimension.

**Engine implementation — `packages/engine/src/journeys/journey-context.ts`.** New `performVariant` beside `performThrottle` (`:836-888`); wired beside `once` (`:1065-1072`); `variantWarned` warn-once `Set` beside `digestWarned` (`:89`).

The validate-vs-never-throw split, RESOLVED: only `validateVariantKey` runs before the recordOnce read; `validateVariantArms` runs only inside the `compute` closure. Consequence: a deploy that ships malformed arms degrades in-flight enrollments to the recorded fast path (no crash — recorded value returned, stale-arm advisory may fire); only FRESH assignments hit the arms validation. This preserves "never crash a live replay" without giving up dev-time loudness for new enrollments.

```ts
const performVariant = async <const A extends readonly [string, ...string[]]>(
  key: string,
  arms: A,
): Promise<A[number]> => {
  validateVariantKey(key); // syntax only — gates the jsonb path
  const journeyId = config.journeyId;
  if (!journeyId) {
    throw new Error(
      "ctx.variant requires the journey id on the context (always set by the engine; pass journeyId in test configs)",
    );
  }

  // RECORD ONCE — first winning writer computes; everyone after (replay,
  // reuse, zombie racer) reads the committed arm back. compute is
  // SYNCHRONOUS and pure (hash only): no clock, no awaits, no durable
  // calls — ctx.variant is positionally invisible in Hatchet's journal.
  const assigned = await recordOnce({
    db,
    stateId,
    namespace: "__variants__",
    key,
    compute: () => {
      validateVariantArms(arms);
      return pickVariant({ journeyId, key, userId, arms });
    },
  });

  // TYPE GUARD then STALE-ARM ADVISORY — recorded value wins VERBATIM
  // (Decision B), even when a redeploy changed the arms mid-enrollment.
  // A fast-path value that is NOT a string is never returned into author
  // code: fall through to a fresh compute-and-record under a guard (defends
  // against pre-stripping legacy rows with injected objects).
  // Warn once per process per journeyId:key; NEVER throw here.
  if (!(arms as readonly string[]).includes(assigned)) {
    /* warn-once via variantWarned, message naming journeyId, key, arm */
  }
  return assigned as A[number];
};
```

**Injection fix — lands IN this phase, not deferred.** Enrollment seeds `journey_states.context` from trigger-event properties on BOTH insert paths (`execute-journey-run.ts:429-431` fresh entry; `~:346` held_out). A publishable-key browser event carrying a property named `__variants__` could otherwise choose its own arm AND inject arbitrary strings into the impact route's GROUP BY dimension — `__variants__` is the first reserved bag that selects user-visible content and feeds an admin readout. Fix: strip ALL FOUR reserved namespace keys (`__once__`, `__digest__`, `__throttle__`, `__variants__`) from event properties at both context-seeding sites (~3-line filter, protects every bag at once). The readout half: the impact route enumerates arms from data and, post-strip, injected arms cannot enter; the fast-path string type guard above covers pre-strip legacy rows.

**Replay semantics (defense in depth)**: (1) same-code replay — recordOnce read-first returns the stored arm; a crash before the record committed means no post-variant side effect ran and the recompute is the identical pure hash. (2) Deploy between crash and replay — recorded arm returned verbatim; the downstream `sendEmail` discriminant stays pinned, so the derived `journeySend:<runAnchor>:<site>:<templateKey>` key collides with the pre-crash send and Layer-2 `email_sends` dedup holds. (3) Zombie double-writer — first-writer-wins jsonb merge + RETURNING read-back. (4) Re-entry — fresh state row, empty bag, recompute; same arm because the hash input has no enrollment-scoped component — PROVIDED the arms array is unchanged.

**Holdout + idempotency interaction**: diversion runs before `run()`, so the `__variants__` bag exists ONLY on treatment rows. No `ctx.once` wrap needed (ctx.variant IS the recorded wrapper). No key-collision throw from the fan-out itself (one user resolves to exactly one arm); the throw remains reachable exactly when an arm value equals the templateKey of ANOTHER send in the same run under the same nearest wait label — the documented `idempotencyLabel` fix applies.

**Deliberate non-behaviors**: no `registerRecordLabel`/`registerKey` (re-reading the same key returning the same arm is intended reuse), no boundary-label write, no transition log (the jsonb is the observability), no graph node (Studio renders `unknown` — cosmetic, deferred).

**Harness parity — `packages/testing`**: compiler-forced (harness context is typed `JourneyContext`). `harness.ts:58` local namespace union + `recordValues`/`pendingRecords` maps (`:111-122`) gain `__variants__`; ctx impl beside `once` (`:1281`) calls the engine's `pickVariant` via `@hogsend/engine/testing` (add `export { pickVariant, validateVariantKey, validateVariantArms, variantBucket } from "./lib/variant.js";` to `packages/engine/src/testing.ts` — the `isHeldOut` channel at `:18`). `JourneyTestOptions` (`packages/testing/src/types.ts:123`) gains `variants?: Record<string, string>`, seeded like `options.once`; a seeded arm outside the journey's arms is returned verbatim silently (documented in the TSDoc). Add a behavioral `ctx.variant` case to `packages/testing/src/context-completeness.test.ts` (the per-primitive suite digest/throttle already use).

**Doc-sync targets (corrected)**: `apps/docs/content/docs/guides/journeys.mdx` — new `ctx.variant` section AND the reserved-keys sentence at `:498` gains `__variants__`; `packages/cli/skills/hogsend-authoring-journeys/SKILL.md:67` (primitive list); `packages/cli/skills/hogsend-authoring-journeys/references/journey-context.md` (~`:111` examples, `:128` reserved-keys list); CLAUDE.md JourneyContext bullet. NOT `packages/engine/src/mcp/authoring-guide.ts` (it is the blueprint-IR guide; nothing to sync).

No DB migration. Changeset notes must call out the strict key charset (`/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/`).

### D3. `meta.goal` boot validation (Decision C)

Type + schema land in D0. This component is the container half; the route-defaulting half is deferred to phase 2a (D4) to avoid the double-edit of the lift handler.

**`ConversionRegistry.has` — `packages/engine/src/lib/conversions.ts`** (next to `getAll`/`count`):

```ts
  has(id: string): boolean {
    return this.all.some((def) => def.meta.id === id);
  }
```

**Hoist the conversion registry local — `container.ts:908-916`** (behavior-identical):

```ts
  const conversionRegistry = new ConversionRegistry(
    seedDefaultRevenue
      ? [...authoredConversions, defaultRevenueConversion]
      : authoredConversions,
  );
  setConversionRegistry(conversionRegistry);
```

The construction is env-sensitive (`HOGSEND_DEFAULT_REVENUE_CONVERSION=false` or an authored `id: "revenue"` suppresses the seed); validation must use THIS registry so `goal: "revenue"` is valid exactly when a `revenue` definition actually exists and throws when the operator opted out without a replacement. That asymmetry is intended.

**Validation loop** — inserted directly after the journey-category boot loop (`container.ts:1065-1075`); throw, not warn (a warn's failure mode is a permanently-wrong default readout; the registry universe is fully known at boot — same posture as the `EMAIL_PROVIDER` throw at `container.ts:957-968` and `validateListCategory`):

```ts
  // Boot-validate every journey's meta.goal against the conversion
  // registry — fail CLOSED. A typo'd id matches zero conversion rows, so
  // every default readout would quietly report 0% for both cohorts — a
  // wrong-but-plausible number, worse than a crash. Validated over DEFINED
  // journeys (not just ENABLED — the ENABLED_JOURNEYS lesson) against the
  // ACTUAL registry (the seeded "revenue" conversion counts, and counts
  // ONLY when actually seeded).
  for (const journey of opts.journeys ?? []) {
    const goal = journey.meta.goal;
    if (!goal) continue;
    if (!conversionRegistry.has(goal)) {
      const known = conversionRegistry
        .getAll()
        .map((def) => def.meta.id)
        .join(", ");
      throw new Error(
        `Journey "${journey.meta.id}" has goal "${goal}", which matches no registered conversion definition (known: ${known || "none"}). ` +
          `A goal must be a defineConversion id passed to createHogsendClient({ conversions }) — or the built-in "revenue" conversion when it is seeded.` +
          (goal === "revenue"
            ? ` Remove HOGSEND_DEFAULT_REVENUE_CONVERSION=false or author an id: "revenue" definition if you meant the built-in.`
            : ""),
      );
    }
  }
```

Runs identically in API and worker processes. One-sentence doc update on the `conversions?` option (`container.ts:460-465`).

**Admin exposure**: `journeySchema` gains `goal: z.string().optional()`; list map adds `goal: j.goal`; detail handler adds `goal: meta.goal` — BOTH handlers read registry meta (`registry.get(id)` at `:608`), so both depend on the D0 schema fix. Patch handler unchanged — `journey_configs` overrides only `enabled` (code-first law); goal is not patchable. Studio `admin-api.ts` journey shapes (`:243`, `:305`) gain `goal?: string` (type-only).

**ENABLED_JOURNEYS asymmetry (documented + tested)**: a DEFINED journey excluded by the `ENABLED_JOURNEYS` csv is never registered (`journeys/registry.ts:163-166`), so its lift/impact readout falls to source `"none"` even though its code declares a goal — while `meta.enabled: false` journeys DO register and keep the goal default. Boot validation (over `opts.journeys`) still runs for the excluded journey. Named in the handler comment, the docs, and a dedicated test.

**Decided (was an open question)**: an EXPLICIT `?definitionId=` that matches no registered definition keeps today's silent behavior (zero conversions → suppressed verdict) — lean, non-breaking; goal typos are boot-impossible, and the query param is an admin-plane debugging knob.

### D4. Shared lift helper + impact readout routes (Decision D)

#### D4.1 Reconciled `computeJourneyLift` — NEW `packages/engine/src/lib/journey-lift.ts`

ONE helper serves `/lift`, `/impact`, and the digest. Reconciled contract (supersedes both component drafts):

```ts
import type { Database } from "@hogsend/db";
import { computeLift, type LiftVerdict } from "./lift-stats.js";

export interface LiftCohort {
  contacts: number;
  converters: number;
  rate: number;
}

export interface JourneyLiftResult {
  treatment: LiftCohort;
  control: LiftCohort;
  verdict: LiftVerdict;
}

/**
 * Holdout lift for one journey — the ONE implementation of the causal math
 * (funnels.ts:16 law). Treatment = status != 'held_out'; control =
 * status = 'held_out'; outcome = ≥1 qualifying conversions row with
 * occurred_at >= the state row's created_at (intent-to-treat clock).
 *
 * `asOf` (default: now) snapshots the read: cohort rows require
 * created_at < asOf and conversions require occurred_at <= asOf. With
 * asOf = now both bounds are no-ops (future-dated rows cannot exist), so
 * the /lift route's behavior is unchanged by the extraction — pinned by a
 * regression fixture.
 */
export async function computeJourneyLift(opts: {
  db: Database;
  journeyId: string;
  since: Date;
  asOf?: Date;
  definitionId?: string;
}): Promise<JourneyLiftResult>;

/**
 * Per-currency qualifying conversion value for both cohorts (not
 * fractional credit). Kept SEPARATE from the counts helper: /lift composes
 * it into its wire shape; the digest and overview never need it.
 */
export async function computeLiftValues(opts: {
  db: Database;
  journeyId: string;
  since: Date;
  asOf?: Date;
  definitionId?: string;
}): Promise<{
  treatment: Array<{ currency: string | null; value: number }>;
  control: Array<{ currency: string | null; value: number }>;
}>;
```

The `versionHash` narrowing parameter from the readouts draft is DROPPED (lean-first): the impact route's version block uses its own grouped SQL and the digest does not window by version — the parameter had no consumer.

Implementation is a mechanical extraction of `journeys.ts:1118-1187` (the `convertedSql` EXISTS fragment at `:1128-1132`, the `cohort(control)` closure restructured into count-helper + separate value helper, `Promise.all`, `computeLift`), plus the `asOf` bounds. Note the restructuring is explicit: today the value query runs INSIDE the route's `cohort()` closure (`:1153-1169`); the extraction splits counts from values and the route merges them back.

#### D4.2 Shared wire schemas — NEW `packages/engine/src/routes/admin/impact-schemas.ts`

Hoisted once, imported by both routers (no ad-hoc duplicates):

```ts
/** LiftVerdict on the wire — matches lib/lift-stats.ts:86-95 exactly. */
export const liftVerdictSchema = z.object({
  liftPercent: z.number().nullable(),
  winProbability: z.number().nullable(),
  suppressed: z.boolean(),
  smallSample: z.boolean(),
});

export const countsSchema = z.object({
  contacts: z.number(),
  converters: z.number(),
  rate: z.number(),
});

/** Counts + per-currency value (never summed across currencies). */
export const cohortSchema = countsSchema.extend({
  value: z.array(
    z.object({ currency: z.string().nullable(), value: z.number() }),
  ),
});
```

#### D4.3 `/lift` refactor + goal defaulting (one sequential change)

The lift handler (`journeys.ts:1114-1200`) is edited ONCE: first delegate to `computeJourneyLift` + `computeLiftValues` (merging values into the cohorts to preserve the existing wire shape), THEN layer the goal-resolution ladder. One combined regression fixture — the response is byte-identical to today EXCEPT the added `definitionSource` field and `definitionId` now echoing the EFFECTIVE id.

Resolution ladder and the SINGLE agreed source enum, used on `/lift`, `/impact`, and the Studio mirror: **`"query" | "goal" | "none"`** (`"goal"` names the meta field; `"none"` is honest about unscoped).

```ts
    const { db, registry } = c.get("container");
    const { id } = c.req.valid("param");
    const { days, definitionId: queryDefinitionId } = c.req.valid("query");

    // definitionId resolution: explicit query param > journey meta.goal >
    // any conversion. registry.get(id) is undefined for (a) deleted/renamed
    // journeys with historical states and (b) DEFINED journeys excluded by
    // the ENABLED_JOURNEYS csv — both keep the pre-goal "any" behavior and
    // report source "none". The route still never 404s.
    const goal = registry.get(id)?.goal;
    const definitionId = queryDefinitionId ?? goal;
    const definitionSource: "query" | "goal" | "none" = queryDefinitionId
      ? "query"
      : goal
        ? "goal"
        : "none";
```

Route schema: query `definitionId` description updated ("Default: the journey's meta.goal; else any conversion."); response gains `definitionSource: z.enum(["query", "goal", "none"])`.

#### D4.4 `GET /v1/admin/journeys/{id}/impact` — NEW `routes/admin/journey-impact.ts`

Mounted `adminRouter.route("/journeys", journeyImpactRouter)` in `routes/admin/index.ts` — inherits `requireAdmin` + `rateLimit` + `auditMiddleware` from the parent chain (`:43-45`); multi-router mounts on one path are established (`/contacts` ×3 at `:47-49`).

**This Zod contract is FINAL and frozen at the end of phase 2b — it IS the Studio contract.** It includes the Studio-required additions (holdout, current version identity):

```ts
const goalSchema = z.object({
  /** Effective conversion definition scoping every outcome below.
   * query.definitionId beats meta.goal beats null (= any definition). */
  definitionId: z.string().nullable(),
  source: z.enum(["query", "goal", "none"]),
  /** Registered definition's display name; null when unscoped/unknown. */
  name: z.string().nullable(),
});

const overallSchema = z.object({
  /** Causal-language law (routes/admin/funnels.ts:16): true ONLY when a
   * held-out cohort exists to compare against. When false, `treatment` IS
   * the observational read (there is no separate observational block —
   * consumers render treatment with the observational label). */
  causal: z.boolean(),
  treatment: cohortSchema,
  control: cohortSchema,
  /** Null when control.contacts === 0 — with zero control contacts,
   * computeLift would integrate against the uniform Beta(1,1) prior and
   * print a confident-looking winProbability: an uninformed prior
   * masquerading as evidence. The impact surface refuses that.
   * (Deliberately stricter than /lift, which emits a verdict regardless.) */
  verdict: liftVerdictSchema.nullable(),
});

const versionSchema = z.object({
  /** journey_version_hash; null = the pre-versioning bucket. Treat a new
   * hash as "possible new version" — toolchain bumps can fork it. */
  hash: z.string().nullable(),
  /** Latest-by-created_at label seen on this hash's rows. Hash is truth. */
  label: z.string().nullable(),
  firstEnrolledAt: z.string().nullable(), // ISO; null if only held_out rows
  lastEnrolledAt: z.string().nullable(),
  enrollments: z.number(),   // distinct treated users, this hash, in window
  converters: z.number(),
  rate: z.number(),
  /** Contemporaneous holdout lift: control = held_out rows carrying the
   * SAME hash (stamped at diversion by the same deployed code). Null when
   * this version diverted nobody. causal: true by construction when
   * present. NOTE: version-INTERNAL lift is causal; comparing raw rates
   * ACROSS versions is observational — older versions had longer
   * post-entry conversion exposure. A salt/percent change between versions
   * can place one user in treatment under one hash and control under
   * another in the UNVERSIONED overall lift (pre-existing in /lift; hash
   * matching makes it visible, and per-version blocks are immune). */
  liftVsControl: z
    .object({ causal: z.literal(true), control: countsSchema })
    .extend(liftVerdictSchema.shape)
    .nullable(),
});

const variantArmSchema = z.object({
  arm: z.string(),
  enrollments: z.number(),
  converters: z.number(),
  rate: z.number(),
  /** OBSERVATIONAL engagement funnel for this arm (email_sends joined via
   * journey_state_id) — the first readout an operator asks for on a
   * subject-line test. */
  engagement: z.object({
    causal: z.literal(false),
    sends: z.number(),
    opened: z.number(),
    clicked: z.number(),
  }),
  /** Arm cohort vs the WHOLE held-out cohort (Decision B). Null when the
   * journey has no held-out contacts in the window. CONDITIONING CAVEAT:
   * an arm cohort is conditioned on the enrollment SURVIVING to the
   * ctx.variant call site (branches, exits, errors during earlier waits)
   * while the held-out cohort is unconditioned — arm-vs-holdout is cleanly
   * causal only when the variant call is unconditional near journey start;
   * arm-vs-arm is the always-clean randomized comparison. */
  liftVsControl: z
    .object({ causal: z.literal(true) })
    .extend(liftVerdictSchema.shape)
    .nullable(),
});

const variantSchema = z.object({
  key: z.string(),
  arms: z.array(variantArmSchema),
});

const impactResponseSchema = z.object({
  journeyId: z.string(),
  days: z.number(),
  goal: goalSchema,
  /** Authored holdout config from the registry meta; null when none or
   * when the journey is unregistered. Requires the D0 schema fix — holdout
   * MUST be read from the fixed schema/registry, never assumed. */
  holdout: z.object({ percent: z.number() }).nullable(),
  /** The CURRENT deployed definition's identity (what a fresh enrollment
   * would stamp); null when unregistered. */
  currentVersionHash: z.string().nullable(),
  currentVersionLabel: z.string().nullable(),
  overall: overallSchema,
  /** Newest version first (by first activity). */
  versions: z.array(versionSchema),
  variants: z.array(variantSchema),
});
```

Route: `createRoute({ method: "get", path: "/{id}/impact", request: { params: { id }, query: { days: z.coerce.number().min(1).max(365).default(90), definitionId: z.string().optional() } }, responses: { 200, 404 } })`. Route description carries the honesty framing: "Only holdout-backed blocks carry causal language; cross-version and no-control numbers are observational." Docs also state the blueprint boundary: blueprint journeys are DB-authored and can never declare `meta.goal` (code-first law), so their readout is permanently `source: "none"` unless a `definitionId` query param is passed — a documented boundary, not a surprise.

**Handler algorithm**:

1. **Resolve goal.** `const meta = registry.get(id)`. `definitionId = queryDef ?? meta?.goal ?? undefined`; `goal.source` per the shared enum; `goal.name = getConversionRegistry().getAll().find(d => d.meta.id === definitionId)?.meta.name ?? null`. `holdout = meta?.holdout ? { percent: meta.holdout.percent } : null`; `currentVersionHash/Label = meta?.versionHash ?? null / meta?.version ?? null`.
2. **404 guard.** `meta` undefined AND `select count(*) from journey_states where journey_id = ${id}` = 0 ⇒ 404. Non-zero ⇒ proceed (covers blueprint enrollments and removed journeys).
3. **Overall.** `computeJourneyLift({ db, journeyId: id, since, definitionId })` + `computeLiftValues(...)` merged into the cohorts. `causal = control.contacts > 0`; `verdict = causal ? result.verdict : null`.
4. **Versions — ONE grouped query, control matched by hash** (raw `db.execute`, params bound):

```sql
select
  js.journey_version_hash                        as hash,
  (array_agg(js.journey_version_label order by js.created_at desc)
     filter (where js.journey_version_label is not null))[1] as label,
  min(js.created_at) filter (where js.status != 'held_out') as first_enrolled_at,
  max(js.created_at) filter (where js.status != 'held_out') as last_enrolled_at,
  count(distinct js.user_id) filter (where js.status != 'held_out')::int as enrollments,
  (count(distinct js.user_id) filter (where js.status != 'held_out' and exists (
     select 1 from conversions c
     where c.user_key = js.user_id
       and c.occurred_at >= js.created_at
       -- appended only when definitionId resolved:
       and c.definition_id = ${definitionId}
  )))::int                                        as converters,
  count(distinct js.user_id) filter (where js.status = 'held_out')::int as control_contacts,
  (count(distinct js.user_id) filter (where js.status = 'held_out' and exists (
     select 1 from conversions c
     where c.user_key = js.user_id
       and c.occurred_at >= js.created_at
       and c.definition_id = ${definitionId}   -- same conditional append
  )))::int                                       as control_converters
from journey_states js
where js.journey_id = ${id}
  and js.created_at >= ${since}::timestamptz
group by js.journey_version_hash
order by min(js.created_at) desc
```

   The label pick is **latest-by-created_at** (the `array_agg` form), standardized across every SQL site in this spec (impact versions, overview, digest) — `max()` is lexicographic and shows stale labels after a label-only rename (the label is excluded from the hash).

   **Control-windowing decision, explicit**: the contemporaneous control for a version is *held_out rows stamped with the same hash*, NOT a date-range slice. Same-hash matching is strictly better: (a) exact even when two code versions run concurrently (blue-green deploy — date windows would cross-contaminate); (b) survives gaps and low-traffic versions; (c) treatment and control share the identical exposure period by construction. The per-row ITT clock (`occurred_at >= created_at`) equalizes post-assignment exposure within the version.

   Per row: `rate = enrollments > 0 ? converters/enrollments : 0`; `liftVsControl = control_contacts > 0 ? { causal: true, ...computeLift(counts), control: {...} } : null`. A hash with only held_out rows renders `enrollments: 0, firstEnrolledAt: null` honestly.

5. **Variants — one lateral counts query + one engagement query + shared control**:

```sql
select
  v.key                                          as variant_key,
  v.arm                                          as arm,
  count(distinct js.user_id)::int                as enrollments,
  (count(distinct js.user_id) filter (where exists (
     select 1 from conversions c
     where c.user_key = js.user_id
       and c.occurred_at >= js.created_at
       and c.definition_id = ${definitionId}     -- conditional append
  )))::int                                       as converters
from journey_states js
cross join lateral jsonb_each_text(js.context -> '__variants__') as v(key, arm)
where js.journey_id = ${id}
  and js.created_at >= ${since}::timestamptz
  and js.status != 'held_out'
  and js.context ? '__variants__'
group by v.key, v.arm
order by v.key, v.arm
```

```sql
-- per-arm engagement (observational): email_sends joined by journey_state_id
select v.key as variant_key, v.arm as arm,
       count(es.id)::int          as sends,
       count(es.opened_at)::int   as opened,
       count(es.clicked_at)::int  as clicked
from journey_states js
cross join lateral jsonb_each_text(js.context -> '__variants__') as v(key, arm)
join email_sends es on es.journey_state_id = js.id
where js.journey_id = ${id}
  and js.created_at >= ${since}::timestamptz
  and js.status != 'held_out'
  and js.context ? '__variants__'
group by v.key, v.arm
```

   `jsonb_each_text` unwraps the recordOnce-stored JSON string values to bare text (`record-once.ts:93`). held_out rows never run `run()` so never carry variants (belt-and-suspenders filter). Arms are enumerated FROM DATA (a removed arm still reports its historical cohort; injection is closed at the seeding strip, D2). Control for every arm = the overall control cohort (Decision B verbatim). Rows enrolled before an experiment shipped have no arm — excluded by the `?` filter, so arm cohorts may sum < treatment total (labeled, not forced into a pseudo-arm). Group into `variants[]` by key in JS.

Steps 3–5 run as `Promise.all`. Total: 7 indexed queries (counts ×2 + values ×2 in the helper pair, versions 1, variants 2), all on `journey_states_journey_id_status_idx` / `conversions_definition_occurred_idx` paths. No new indexes shipped (lean); `conversions (user_key, occurred_at)` flagged as the profile-first candidate.

#### D4.5 `GET /v1/admin/impact/overview` — NEW `routes/admin/impact.ts`

Mounted `adminRouter.route("/impact", impactOverviewRouter)`.

```ts
import { ATTRIBUTION_MODELS } from "@hogsend/attribution"; // engine already depends

const overviewLiftSchema = z.object({
  causal: z.literal(true),
  control: countsSchema,
}).extend(liftVerdictSchema.shape);

const journeyRowSchema = z.object({
  journeyId: z.string(),
  /** Registry name; null for blueprint/removed-journey ids observed only
   * in journey_states or the credit ledger. */
  name: z.string().nullable(),
  registered: z.boolean(),
  versionLabel: z.string().nullable(), // latest-by-created_at in window
  goalDefinitionId: z.string().nullable(),
  /** Authored holdout percent from registry meta; null when none or
   * unregistered. Lets consumers distinguish "no holdout configured" from
   * "holdout configured, no held-out contacts in window yet". */
  holdoutPercent: z.number().nullable(),
  /** OBSERVATIONAL — enrollment funnel of the TREATED cohort only
   * (status != 'held_out'), matching the lift route's cohort split.
   * Nested so `causal` is unambiguous per block, never per row. */
  observational: z.object({
    causal: z.literal(false),
    enrollments: z.number(),
    converters: z.number(),
    rate: z.number(),
  }),
  /** OBSERVATIONAL — fractional credit from the ledger, one model. */
  attributed: z.object({
    causal: z.literal(false),
    model: z.enum(ATTRIBUTION_MODELS),
    values: z.array(z.object({
      currency: z.string().nullable(),
      value: z.number(),        // sum(credit.value)
      conversions: z.number(),  // sum(credit.weight)
    })),
  }),
  /** CAUSAL — present only where a held-out cohort exists in the window. */
  lift: overviewLiftSchema.nullable(),
});

const campaignRowSchema = z.object({
  campaignId: z.string(),
  name: z.string(),
  status: z.string(),
  sends: z.number(),
  delivered: z.number(),
  opened: z.number(),
  clicked: z.number(),
  attributed: z.array(z.object({
    currency: z.string().nullable(),
    value: z.number(),
    conversions: z.number(),
  })),
});

/** Zod-4-safe: discriminated on `state` (single distinct key), NOT on a
 * duplicated `enabled: true` literal — z.discriminatedUnion("enabled",
 * [..two true branches..]) THROWS at construction on zod 4.4.3. */
const globalControlSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("off") }),
  z.object({
    /** Assignment is ON and suppressing sends, but the readout was skipped:
     * contact population exceeds the in-request scan ceiling. Visibly
     * distinct from "off" — assignment-active-readout-absent must never
     * render as disabled. */
    state: z.literal("skipped"),
    reason: z.literal("too_many_contacts"),
    percent: z.number(),
    contactCount: z.number(),
  }),
  z.object({
    state: z.literal("computed"),
    causal: z.literal(true),
    percent: z.number(),          // globalControlPercent() (holdout.ts:42-46)
    contactsScanned: z.number(),
    treatment: countsSchema,
    control: countsSchema,
  }).extend(liftVerdictSchema.shape),
]);

const overviewResponseSchema = z.object({
  days: z.number(),
  model: z.enum(ATTRIBUTION_MODELS),
  rankedBy: z.literal("converters"),
  journeys: z.array(journeyRowSchema),
  campaigns: z.object({
    causal: z.literal(false), // correlational-only, whole section
    rows: z.array(campaignRowSchema),
  }),
  globalControl: globalControlSchema,
});
```

Query: `{ days: z.coerce.number().min(1).max(365).default(90), model: z.enum(ATTRIBUTION_MODELS).default("linear") }`. **Decided**: `linear` is the default model (matches the enumeration model `attribution.ts` standardizes on at `:262`/`:321`); switching is a query param.

**Handler algorithm**:

**(a) Journey base rollup** — one grouped query over `journey_states` in window (as in the component design: treatment/control distinct-user counts + any-definition EXISTS converters + latest-by-created_at `version_label` via `array_agg`).

**(b) Goal refinement** — for journey ids where `registry.get(id)?.goal` is set, re-run the aggregate **with `and js.journey_id = ${id}` in the WHERE** (per-journey, never a full re-scan) and `and c.definition_id = ${goal}` in both EXISTS; goal-scoped converters/control_converters replace the any-definition counts for that row only. `Promise.all`, bounded by registry size.

**(c) Attributed value** — one grouped ledger query (`attribution_credits` where `model = ${model} and converted_at >= ${since} and journey_id is not null`, grouped by journey_id + currency, summing value + weight).

**Assemble `journeys[]` as the UNION of journey ids from (a) AND (c)** — a journey with in-window credits but zero in-window state rows still appears with observational counts of 0 ("this journey attributed £X" must not vanish because its enrollments predate the window). Enrich: `name`/`registered`/`goalDefinitionId`/`holdoutPercent` from the registry; `attributed.values` from (c); `lift = control_contacts > 0 ? { causal: true, ...computeLift(counts), control } : null` (computed in JS from the four counts — no extra queries). Sort `converters desc, enrollments desc, journeyId asc`; `rankedBy: "converters"` emitted so clients don't guess.

**(d) Campaigns — correlational only, activity-windowed enumeration.** Enumerate campaign ids from the in-window `email_sends` split_part rollup ∪ in-window `attribution_credits.campaign_id` (NOT "newest 50 created in window" — that drops older-but-active multi-step/scheduled campaigns whose sends fall inside the window). Then fetch name/status for those ids, cap 50 by activity (send volume desc). Send funnel in one pass:

```sql
select split_part(idempotency_key, ':', 2) as campaign_id,
  count(*)::int            as sends,
  count(delivered_at)::int as delivered,
  count(opened_at)::int    as opened,
  count(clicked_at)::int   as clicked
from email_sends
where idempotency_key like 'campaign:%'
  and created_at >= ${since}::timestamptz
group by 1
```

plus the ledger query (c) re-run keyed on `campaign_id`. Join in JS. The whole section sits under `campaigns.causal: false` — no lift, no win probability, ever.

**(e) Global-control block — JS re-hash, batched.** Assignment lives only in env + hash (no assignment table), so the readout recomputes membership exactly as the mailers do:

1. `globalControlPercent() === 0` → `{ state: "off" }`.
2. `select count(*) from contacts where deleted_at is null` — if > 500,000, `{ state: "skipped", reason: "too_many_contacts", percent, contactCount }` (honest ceiling; the cached cron materialization is explicitly deferred).
3. Converter set into a JS `Set<string>`: `select distinct contact_id from conversions where occurred_at >= ${since}` — ALL definitions aggregate (global control suppresses all non-transactional sends, so any registered conversion is a fair program-level outcome; no definitionId knob in v1).
4. Keyset-paginate live contacts, batch 5,000 (`id > cursor order by id asc limit 5000`).
5. Per contact, `key = externalId ?? anonymousId ?? id` — the canonical text key journey/campaign sends pass as `options.userId`, which is what `isGlobalControl(options.userId ?? options.to)` hashes at send time (`tracked.ts:245-246`). Tally treatment/control contacts + converters via the Set. *Disclosed approximation (doc comment)*: a send made with NO userId hashes the recipient email; a contact reached only that way may be bucketed differently at send time — bounded to bare `POST /v1/emails` traffic.
6. `computeLift({ treatment, control })` → `{ state: "computed", causal: true, percent, contactsScanned, ... }`. ITT caveat in the route doc: cross-sectional randomized comparison, outcome window `occurred_at >= since` for both buckets — random assignment keeps it causal, window symmetry keeps it fair.

**Freeze the OpenAPI shapes at the end of phase 2b.** They are the Studio contract; Studio types are then written mechanically from them.

### D5. Impact digest (Decision E)

A weekly engine-owned Hatchet cron that detects (1) newly-observed journey version hashes and label changes ("you shipped a change") and (2) holdout lift crossing a win-probability threshold ("this is working / hurting"), and emits ONE facts-only `impact.digest` outbound event through `emitOutbound`. No email. No new tables. Read-only except the emit.

Pattern note: `checkAlertsTask` has no cron in code; the cron wiring pattern is `onCrons: [process.env.<VAR> ?? "<default>"]` (bucket-reconcile). check-alerts supplies self-bootstrap (`createDatabase` + `createLogger` off `process.env`, `:198-201`), exported detection seams, and per-section try/catch degradation.

**Task — NEW `packages/engine/src/workflows/impact-digest.ts`**:

```ts
const DEFAULT_WIN_PROB_THRESHOLD = 0.95;
const DEFAULT_LOOKBACK_DAYS = 7;    // first-ever run window
const MAX_LOOKBACK_DAYS = 30;       // clamp on the watermark
const LIFT_WINDOW_DAYS = 90;        // mirrors the lift route default
const ENTRY_CAP = 50;
const CANDIDATE_CAP = 200;
const LIFT_CONCURRENCY = 5;         // pool for computeJourneyLift pairs

export const impactDigestTask = hatchet.task({
  name: "impact-digest",
  onCrons: [process.env.IMPACT_DIGEST_CRON ?? "0 9 * * 1"], // Mondays 09:00 UTC
  retries: 1,
  executionTimeout: "300s", // budget: 200 candidates × 2 snapshots × 2 count
                            // queries ≈ 800 queries at pool 5 — fits with room
  concurrency: {
    expression: "'impact-digest'",
    maxRuns: 1,
    limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
  },
  fn: async (): Promise<{ emitted: boolean; reason?: string; entries?: number; since?: string; until?: string }> => { ... },
});
```

`fn` body, in order (each step its own try/catch; failure logs + degrades):

1. **Bootstrap**: `createDatabase({ url: process.env.DATABASE_URL ?? "" })` + `createLogger` (cron runs have no request container).
2. **Subscriber pre-check** (the opt-in gate — there is no ENABLE env var, see below): select `webhookEndpoints.id` with the EXACT predicate `emitOutbound` uses (`outbound.ts:376-385`): `disabled = false AND organization_id IS NULL AND event_types @> '["impact.digest"]'::jsonb`. Zero rows → `{ emitted: false, reason: "no_subscribers" }`.
3. **Watermark** (no new storage): `select max(created_at) from webhook_deliveries where event_type = 'impact.digest'`. `until = new Date()`; `since = clamp(maxCreatedAt ?? until − 7d, floor = until − 30d)`. Note the `(endpointId, dedupeKey)` index is a plain uniqueIndex relying on NULL-distinctness, NOT a partial index — do not add a WHERE predicate. Self-healing: pruned delivery rows widen the window at most to the 30-day clamp.
4. **Detection A + label pass + Detection B** (below), composed by `buildImpactDigest`.
5. **Empty digest never emitted**: zero entries → return without emitting; the watermark intentionally does not advance.
6. **Emit**: `dedupeKey = "impact.digest:" + until.toISOString().slice(0, 10)` (UTC day). `emitOutbound` never throws; per-endpoint fan-out dedupe is `onConflictDoNothing` on `(endpointId, dedupeKey)`. Consequence, documented: at most one digest per endpoint per UTC day even on a sub-daily cron. Cross-midnight retry edge is self-healing (retry re-reads the watermark, window collapses to minutes, almost surely zero entries).

Replay-law note: this is a CRON task, not a journey — `Date.now()` is legal; determinism is delivered by the dedupeKey.

**Detection A — "you shipped a change" (`causal: false`).** Two queries, not one (the window-filtered GROUP BY cannot supply earlier hashes' first-seen):

```sql
-- 1. versions first observed inside the window
select journey_id, journey_version_hash,
       (array_agg(journey_version_label order by created_at desc)
          filter (where journey_version_label is not null))[1] as version_label,
       min(created_at) as first_seen_at
from journey_states
where journey_version_hash is not null and deleted_at is null
group by journey_id, journey_version_hash
having min(created_at) >= $since and min(created_at) < $until
```

```sql
-- 2. all-time first-seen per (journey_id, hash) for the affected journey_ids
--    — needed to classify new_journey vs new_version and pick `previous`
select journey_id, journey_version_hash, min(created_at) as first_seen_at,
       (array_agg(journey_version_label order by created_at desc)
          filter (where journey_version_label is not null))[1] as version_label
from journey_states
where journey_id = any($affectedIds) and journey_version_hash is not null
  and deleted_at is null
group by journey_id, journey_version_hash
```

Classification: `new_journey` when no other hash predates `first_seen_at`; else `new_version` with `previous` = the hash with the greatest earlier first-seen. **Label pass (`new_label`)**: after hash classification, find `(journey_id, journey_version_label)` pairs first observed in-window whose hash first-seen PREDATES the window — a label-only change (same content hash). This is the first-class "shipped" signal for template reworks, which the hash cannot see; the documented operator practice (bump the label when you rework a template) makes the digest honest about the most common edit class. `new_label` entries carry `previousVersionLabel` and `previous: null`.

Per-version observational cohorts reuse the lift route's outcome semantics exactly (treatment-only, EXISTS with ITT clock, goal-conditional `definition_id` append). `goalDefinitionId = getJourneyRegistrySingleton().get(journeyId)?.goal ?? null` — the accessor is `get(id): JourneyMeta | undefined` returning flat meta (`registry/index.ts:32-34`; there is NO `getById` and NO `.meta` wrapper); `journeyName` via `?.name`. Registry miss (blueprint journey) ⇒ nulls, degraded never crashed. Blueprint enrollments are covered automatically (this reads `journey_states`, not the code registry). Detection A is inert until Decision A's columns fill (the `IS NOT NULL` filter) — safe parallel shipping. **Index (owned here per the recorded deferral)**: if EXPLAIN on query 1 shows a full-table seq scan hurting at real volume, THIS phase's migration adds `(journey_id, journey_version_hash)` on `journey_states`.

**Detection B — "working / hurting" (`causal: true`).** Candidates: `select distinct journey_id from journey_states where status = 'held_out' and deleted_at is null and created_at >= $until - interval '90 days'`, capped at `CANDIDATE_CAP` (warn if hit). Per candidate, via the unified helper with the pool:

```ts
const now  = await computeJourneyLift({ db, journeyId, definitionId: goal, since: subDays(until, 90), asOf: until });
const prev = await computeJourneyLift({ db, journeyId, definitionId: goal, since: subDays(since, 90), asOf: since });
```

Crossing logic (nested verdict, consistently — resolving the drafts' field-access drift), `T = clamp(Number(process.env.IMPACT_DIGEST_WIN_PROB) || 0.95, 0.5, 0.999)`. Include a `lift` entry iff `!now.verdict.suppressed && now.verdict.winProbability !== null` AND:

- `direction: "up"`: `now.verdict.winProbability >= T && (prevWinProb === null || prevWinProb < T)`
- `direction: "down"`: `now.verdict.winProbability <= 1 − T && (prevWinProb === null || prevWinProb > 1 − T)`

**Frozen-payload override (the drift hole)**: `prevWinProb` is taken from the LAST digest delivery's stored payload when available — `webhook_deliveries.payload` jsonb contains the frozen envelope (`outbound.ts:389-395`), so the as-REPORTED winProbability set is read from the latest `impact.digest` delivery and overrides the live recompute at `asOf = since`. Late-arriving/backfilled conversions can otherwise retroactively flip last week's probability across T, silently swallowing a real crossing or re-reporting one already sent. The recompute remains the fallback for journeys absent from the last payload.

Suppression is absolute (a suppressed verdict never produces an entry); `smallSample` never blocks — it rides the payload verbatim. Crossing (not level) semantics: no weekly re-nag. The down side is included deliberately.

**Payload — `OutboundPayloads["impact.digest"]`** (plain TS interfaces, `lib/outbound.ts` after `journey.heldout`, ~`:258`; exported):

```ts
"impact.digest": {
  periodKey: string;        // UTC YYYY-MM-DD of the emit
  since: string;            // ISO — watermark (last digest delivery, clamped 30d)
  until: string;            // ISO — this run's snapshot instant
  entries: ImpactDigestEntry[]; // lift first (desc |winProb − 0.5|), then
                                // shipped (desc firstSeenAt); capped at 50
  truncated: boolean;
};

export interface ImpactVersionCohort {
  versionHash: string;
  versionLabel: string | null;
  /** All-time distinct treated users for this version — deliberately NOT
   * windowed by `days` (named to say so; the /impact route's version rows
   * ARE windowed). */
  enrollmentsAllTime: number;
  converters: number;
  conversionRate: number;   // converters / enrollmentsAllTime, 0 when empty
  /** Exposure-window metadata: current vs previous cohorts have DIFFERENT
   * exposure (a 3-day-old version vs a 60-day-old one is not a fair rate
   * comparison). Subscribers MUST normalize or caveat against these. */
  firstSeenAt: string;      // ISO min(created_at) of this hash
  exposureDays: number;     // (until − firstSeenAt) in whole days
}

export interface ImpactDigestShippedEntry {
  kind: "shipped";
  causal: false;            // literal — the law, in the type; entries
                            // structurally CANNOT carry lift fields
  journeyId: string;
  journeyName: string | null;   // null for blueprint/unregistered journeys
  versionHash: string;
  versionLabel: string | null;
  change: "new_journey" | "new_version" | "new_label";
  previousVersionLabel: string | null; // set for new_label
  firstSeenAt: string;
  goalDefinitionId: string | null;
  current: ImpactVersionCohort;
  previous: ImpactVersionCohort | null;  // null for new_journey / new_label
}

export interface ImpactDigestLiftEntry {
  kind: "lift";
  causal: true;             // literal
  journeyId: string;
  journeyName: string | null;
  goalDefinitionId: string | null;
  windowDays: number;       // 90
  direction: "up" | "down";
  treatment: { contacts: number; converters: number; rate: number };
  control: { contacts: number; converters: number; rate: number };
  liftPercent: number | null;
  winProbability: number;   // never null here (suppressed entries excluded)
  previousWinProbability: number | null;
  smallSample: boolean;
}

export type ImpactDigestEntry = ImpactDigestShippedEntry | ImpactDigestLiftEntry;
```

**Catalog sync — FIVE touch points** (see Cross-cutting): `webhook-signing.ts` tuple + stale count comment (currently says "21", actual is 29, becomes **30**), `outbound.ts` payload types, the two vendored copies (`packages/cli/src/commands/webhooks.ts:12-44` — its own stale "21" comment fixed too; `packages/client/src/types.ts:344-379`), and the destination presets: **`destinations/presets/posthog.ts` must `return null` for `impact.digest`** — the generic capture resolves distinct_id from `userId ?? anonymousId ?? to ?? userEmail`, none of which exist on this payload; without the guard the capture ships no distinct_id, PostHog 400s, and the delivery dead-letters as non-retryable every week. **Decided**: the segment preset ALSO skips `impact.digest` (today it would emit a junk track keyed on `anonymousId: envelope.id` — noise; skipping is honest). The webhook-signing comment notes `impact.digest` is the one self-referential event (watermark derived from its own delivery rows).

**env.ts** (next to `BUCKET_RECONCILE_CRON`, `:255-256`):

```ts
// Cadence for the engine-owned impact digest cron. Read raw off
// process.env by onCrons at module load; declared here for the
// validated-env contract (the OUTBOUND_WEBHOOK_REAPER_CRON stance).
IMPACT_DIGEST_CRON: z.string().default("0 9 * * 1"),
// Win-probability crossing threshold for "lift" entries; task default 0.95.
IMPACT_DIGEST_WIN_PROB: z.coerce.number().min(0.5).max(0.999).optional(),
```

**Decided (lean-first)**: NO `ENABLE_IMPACT_DIGEST` env var — it was redundant with the design's own opt-in model (the real opt-in is an endpoint subscribing to `impact.digest`; with no subscriber the task no-ops in one indexed query).

**Registration + exports**: `worker.ts` imports + registers `impactDigestTask` in `baseWorkflows` after `checkAlertsTask` (`:26`, `:130`); `index.ts` exports `impactDigestTask` + seams `detectShippedVersions`, `detectLiftCrossings`, `buildImpactDigest` (single-object-in/result-object-out) + `computeJourneyLift`/`computeLiftValues` from the lib.

**Non-goals**: no email/SMS sends (rendering the digest as an email is a subscriber choice, never engine behavior); no causal language on non-holdout entries (enforced at the type level); no global-control or per-variant entries in v1; no writes beyond `emitOutbound`'s delivery rows; no empty digests; no level-based re-nagging. **Noted deferral**: the digest has no in-product surface — an operator with zero configured destinations (the fresh-scaffold default) never sees it; a cheap "recent changes" strip on Studio's /impact reading the same detection queries is a candidate follow-up, not v1.

### D6. Studio surfaces

Observe-only (law 4): zero mutations. Every rendered number carries an explicit causal/observational marker. All code in `packages/studio`; dark-only crimzon, no green/amber (direction = sign + chevrons, confidence = winProbability text).

**Mirror types — `packages/studio/src/lib/admin-api.ts`.** Written MECHANICALLY from the frozen phase-2b Zod schemas (D4.4/D4.5), not designed independently — the engine owns the shapes (field names `arm` not `variant`, nested `observational`/`attributed`/`lift` blocks, campaign send-funnel columns `sends/delivered/opened/clicked`, the three-state `globalControl` union on `state`, `goal.source: "query" | "goal" | "none"`). Fetchers:

```ts
export function getJourneyImpact(id: string, days = 90) {
  return api.get<JourneyImpact>(
    `/v1/admin/journeys/${encodeURIComponent(id)}/impact`,
    { query: { days } },
  );
}
export function getImpactOverview(days = 90) {
  return api.get<ImpactOverview>("/v1/admin/impact/overview", {
    query: { days },
  });
}
```

`qk` map entries: `journeyImpact: (id, days) => ["journey-impact", id, days] as const` and `impactOverview: (days) => ["impact-overview", days] as const`. No client for the older `/lift` route (it keeps zero consumers; `/impact` supersedes it for Studio).

**Honest-rendering primitives — NEW `packages/studio/src/components/lift.tsx`.** The causal-language law in pixels; both views import from here so the rules can't drift.

- `CausalBadge({ causal })` — bright outline "Causal" vs dim "Observational"; rendered next to EVERY lift/rate figure.
- `CohortLine({ label, cohort })` — "N contacts · K converters · R%" plus per-currency value strip (`formatAmountWithCode`, one span per currency — never summed).
- `LiftValue({ verdict, combinedConversions })` exact rules:
  1. `verdict === null` → `—` (`text-white/40`).
  2. `verdict.suppressed` → `Collecting — {combinedConversions ?? 0} of 10 conversions needed`. NEVER the percentage (under 10 combined conversions it is noise wearing a percentage sign, `lift-stats.ts:12`). `winProbability` is already null here.
  3. `verdict.liftPercent === null` and NOT suppressed (control converts at 0% with ≥10 combined conversions) → `n/a — control converts at 0% · {p}% win probability` — the engine still computes winProbability in this state (`lift-stats.ts:113-120`; null only when suppressed) and it is exactly the causal number the law permits; do not drop it.
  4. Otherwise `{sign}{Math.abs(liftPercent).toFixed(1)}%` with ChevronUp/Down; append `· {(winProbability*100).toFixed(0)}% win probability` when non-null; append `· small sample (<100 per cohort)` when `smallSample`.

Scaling hazard, annotated in code: engine `liftPercent` is ALREADY ×100 (`lift-stats.ts:109-111`) → `toFixed(1)`, while cohort rates are 0–1 fractions → `formatPercent`. The literals `10` and `100` duplicate `MIN_COMBINED_CONVERSIONS`/`SMALL_SAMPLE_FLOOR` (`lift-stats.ts:18-19`); Studio cannot import from the engine package — keep the literals with a comment pointing at `lift-stats.ts:18-19`.

**Journey-detail Impact card — NEW `views/journeys/journey-impact.tsx`**, mounted in `journey-detail-view.tsx` between `JourneyFlow` and `JourneyRevenueCard`. Fixed 90-day window. Loading → Skeleton. Error handling — a DELIBERATE divergence from `JourneyRevenueCard` (which hides on ANY error at `:87`): hide ONLY on `ApiError` 404 (older engine without the route); any other error → `<ErrorState error={query.error} onRetry={() => query.refetch()} />` (never bare `error` — JSX shorthand passes `true` and loses the ApiError message).

Layout: (a) goal row in the header subtitle (`Goal: <code>{definitionId}</code> · last 90 days`, ` (declared in meta.goal)` when `source === "goal"`; source `"none"` → "Goal: any conversion · declare meta.goal to pin this readout"). (b) `overall.causal` → CausalBadge + LiftValue headline + treatment/control CohortLines with holdout percents. (c) No-lift branch, **split on holdout config** (the honesty fix):

- `holdout !== null && overall.verdict === null` → "Holdout configured ({percent}%) — no held-out contacts in this window yet; lift appears once enrollments accrue." NEVER the add-a-holdout snippet (they already have one).
- `holdout === null` → observational CohortLine (from `overall.treatment`) + dashed hint block with the `defineJourney` `holdout: { percent: 10 }` code snippet + `DocLink` to `links.impact`. No toggle — holdout config lives in code (law 3).

(d) Version timeline table when `versions.length > 0`: Version (`label ?? hash.slice(0,12) ?? "pre-versioning"`, "current" badge when `hash === currentVersionHash`), Enrolled, Window, Entered rate, Held-out rate, Lift (`LiftValue` off `liftVsControl` — a version with zero held-out contacts renders `—`, never an observational number wearing the lift column). (e) Variant tables when `variants.length > 0`: Arm | Contacts | Converters | Rate | Opens | Clicks | Lift vs held-out; footnote when `holdout === null`: "Arms are compared observationally — add a holdout for causal per-arm lift." (f) EmptyState when zero contacts in both cohorts.

**Impact overview view — NEW `views/impact-view.tsx`** at route `/impact`. PageHeader; three cards:

- **Journeys**: server-ranked table (Studio never re-sorts) — Journey (Link), Goal, Enrolled/Converters/Rate (from the `observational` block — treatment-only counts, so `combinedConversions = observational.converters + (lift?.control.converters ?? 0)` never double-counts), Attributed value (stacked per-currency, never summed), Lift (`LiftValue`), Evidence (`CausalBadge causal={row.lift !== null}` — derived from lift presence, never a row-level flag). `lift === null` tooltip conditioned on `holdoutPercent`: non-null → "Holdout configured — no held-out contacts in window yet."; null → "No holdout on this journey — add holdout: { percent } to its meta."
- **Campaigns**: section-wide Observational badge once in the header; columns Campaign (Link) | Status (StatusBadge) | Sends | Delivered | Opened | Clicked | Attributed value (mirroring the engine's send-funnel columns — no converters/rate column exists in the contract).
- **Global control** — all THREE states rendered: `state: "off"` → dashed hint block with `GLOBAL_CONTROL_PERCENT=5` env snippet (env config, not a Studio toggle); `state: "skipped"` → "Global control is ON ({percent}%) and suppressing sends, but the readout was skipped: {contactCount} contacts exceeds the in-request scan ceiling" — visibly distinct from off; `state: "computed"` → StatCard grid (Control slice / Treatment rate / Control rate) + CausalBadge + LiftValue row.

**Route + nav** (`routes/index.tsx`, `components/layout/nav.ts`): `impactRoute` at `/impact`, nav entry `{ label: "Impact", path: "/impact", icon: TrendingUp }` after Overview. **Decided**: the nav entry ships in the same release as the routes (no dead-end is possible; holding it for data was the only argument and the empty states are honest). `lib/links.ts` gains `impact: ${DOCS}/docs/conversions/impact`.

**Verification**: no Studio test harness exists — `pnpm check-types` + `pnpm lint`, then the real-app smoke matrix (all four LiftValue states, both no-lift branches, three global-control states, version timeline fork after a run-body edit) and a screenshot pass per the show-preview-before-merge rule.

### D7. Dogfood adoption + consolidated docs (Decision F)

Content-only changes in `apps/api` + ONE pass over `apps/docs/content/docs/conversions/impact.mdx`. **This component owns ALL impact.mdx edits** — the engine components contribute JSDoc only (resolves the quadruple-write; line anchors are re-derived at edit time, not trusted from this spec).

**Adoption matrix** — 29 journeys across 23 files (`journeys/index.ts:35-65`; discord-gamification.ts exports 4, discord-lifecycle.ts 2, demo-inapp.ts 3). FIVE journeys trigger on `user.created` (activation-welcome, activation-nudge-series, ai-onboarding, feedback-nps, sms-welcome) — three of the five hold out, so each measured lift is MARGINAL on top of the others' sends, never additive (documented).

Holdout + goal + version:

| Journey | Trigger / entryLimit | holdout | goal |
|---|---|---|---|
| `activation-welcome.ts` | `user.created` / once | `{ percent: 10 }` | `"revenue"` |
| `activation-nudge-series.ts` | `user.created` / once | `{ percent: 10 }` | `"revenue"` |
| `ai-onboarding.ts` | `user.created` / once | `{ percent: 10 }` | `"revenue"` |
| `conversion-trial-upgrade.ts` | `trial.started` / once | `{ percent: 10 }` | `"revenue"` |
| `conversion-abandoned-checkout.ts` | `checkout.abandoned` / once_per_period 3d | `{ percent: 10 }` | `"revenue"` |
| `reactivation-dormancy.ts` | `user.dormancy_detected` / once_per_period 60d | `{ percent: 15 }` | `"revenue"` |
| `ai-reengagement.ts` | `user.dormant_30d` / once_per_period | `{ percent: 15 }` | `"revenue"` |

15% on winbacks: effects are small and the cost of withholding from dormant users is low — a bigger control buys resolution cheaply. No `salt` anywhere (the journey-id default is correct; rotation is a deliberate future action). The `ctx.once` calls in ai-onboarding/ai-reengagement are already replay-safe; run bodies untouched.

Goal + version, NO holdout: `churn-prevention.ts` (goal `"revenue"` — dunning is quasi-transactional; withholding payment-failure notices is forfeited revenue, not learning) and `link-click-campaign.ts` (goal `"lead-submitted"` — the one lead-shaped binding in apps/api; the honest distinguisher from the other connector journeys is volume plus a conversion-shaped outcome, not replay risk).

Untouched: `feedback-nps.ts` / `detractor-rescue.ts` (measurement/service-recovery; feedback-nps FEEDS detractor-rescue via `ctx.trigger` — a holdout would starve it); `retention-milestone.ts`, `referral-invite.ts` (volume never clears the 100-contact floor); all connector/demo/test journeys.

**`retention-weekly-digest.ts` — excluded, corrected rationale.** The engine ALREADY dedupes held_out rows once-ever per (user, journey) (`execute-journey-run.ts:330-339`) — there is NO row spam. The honest reasons: (a) **enrollment-unit mismatch** — an unlimited-entry journey gives treated users one state row per `feature.used` enrollment while a held-out user gets exactly ONE row ever, so the lift comparison is enrollments-vs-contacts with skewed denominators; (b) a deterministically held-out user is starved of EVERY weekly digest indefinitely — a real product cost for a retention digest; (c) the single held_out row's `created_at` anchors the outcome window at first diversion only, so conversions from later would-have-been digests attribute to a months-old cohort entry.

**Decision-F deviation, flagged loudly**: `deal-sold`/`deal-quoted` have no honest owning journey in apps/api — no journey here touches the deal pipeline (the CRM/prospect motion lives in the npm-consuming sibling dogfood repo). They stay registered as conversion points (instances fire, attribution flows); their goal bindings land in the sibling repo's prospect journeys after `hogsend upgrade`. `apps/api/src/conversions/index.ts` is NOT modified. **Decided (was an open question)**: v1 stays revenue-only for the activation goals; a valueless `user-activated` milestone conversion (~5 lines, faster-resolving) is a follow-up any time, not a blocker.

**Version labels**: date-stamped content epoch — `version: "2026-07-baseline"` on all nine touched journeys; `activation-welcome` carries `version: "2026-07-welcome-subject-ab"`.

**THE ctx.variant experiment** — `activation-welcome`, subject line of the first send, arms `["setup", "outcome"]`, same template both arms (send key arm-independent; no `idempotencyLabel` needed; zero new templates):

```ts
  const arm = await ctx.variant("welcome-subject", ["setup", "outcome"]);

  await sendEmail({
    to: user.email,
    userId: user.id,
    journeyStateId: user.stateId,
    template: Templates.ACTIVATION_WELCOME,
    subject:
      arm === "outcome"
        ? "Welcome to Hogsend — your first journey live in 15 minutes"
        : "Welcome to Hogsend — let's get you set up",
    journeyName: user.journeyName,
  });
```

Per-variant lift = arm vs the whole held-out cohort; the per-arm open/click read ships in the /impact variants engagement block (D4.4) — the dogfood promise has an engine surface.

**`apps/api/.env.example`** gains:

```bash
# Program-level global control (holdout across ALL sends). OFF for the
# dogfood: at current signup volume a 5% global cohort stays under the
# 100-contact small-sample floor indefinitely, and global control
# suppresses EVERY send for those contacts (email AND SMS), including
# lifecycle mail we owe customers. Per-journey holdout is the causal
# instrument at this volume.
GLOBAL_CONTROL_PERCENT=0
```

**Regression test — NEW `apps/api/src/__tests__/impact-meta.test.ts`** (pure meta assertions over the exported arrays): every `goal` names a registered conversion or the seeded `revenue`; every holdout has `0 < percent <= 50` AND carries a goal + version label; unlimited-entry journeys never carry a holdout — test named for the REAL rationale ("enrollment-unit mismatch"), not row spam.

**The ONE impact.mdx pass** (current file: 81 lines; nav already lists `impact`). Edits: Day-7 bullet sentence ("With `goal` set on the journey's meta, the endpoint defaults to that conversion definition."); four new sections between the first-week checklist and `## Reading guide`; two reading-guide rows; one new paragraph. Content requirements (facts-only, every sentence survives the deletion test):

1. **"Bind a goal"** — the meta snippet, boot-throw behavior (seeded `revenue` counts), lift/impact default, query override; holdout placement guidance (10% steady lifecycle, 15% winbacks, none on dunning); the marginal-lift caveat for shared triggers.
2. **"Versions: which edit moved the number"** — honest hash scope: *"Edit the run body — a subject line, a sleep, a branch — or the meta: the hash changes. Toggling `enabled` does not. Template component edits (src/emails/) are NOT in the hash; bump the version label when you rework a template — the digest reports label changes as shipped changes."* Label is display, hash is truth, pre-feature rows are "unversioned".
3. **"Variants: split inside the treatment"** — the two guarantees stated SEPARATELY: (1) within one enrollment, the recorded assignment is replayed verbatim, even if the arms array is later edited; (2) a re-entry re-derives the arm from the same deterministic hash, so it gets the same arm as long as the arms array is unchanged — editing arms between entries may reassign re-entrants. Holdout-diverts-first; same-template send-key note; the different-templates discriminant note.
4. **"The impact readout, and the digest"** — the two endpoints, the per-number `causal` flag, suppression rules (10 combined / 100 per cohort), the digest subscribe step (`impact.digest` in an endpoint's eventTypes), the two entry kinds, env knobs.
5. **"Ending a holdout"** (the lifecycle gap, closed here) — removing `holdout` from meta is the graduation mechanism: subsequent triggers enroll previously-held-out users normally; their aged `held_out` row keeps anchoring the old versions' lift readouts (by design — it is that era's control); the digest will read the resulting cohort shift as the new version's numbers.
6. Reading-guide rows for both endpoints: "mixed, per-number `causal` flag / 'caused' only where `causal: true`".

**Rollout**: apps/api consumes `workspace:^` — same release train, engine first (these changes won't type-check before D0–D5 land). Sibling dogfood repo: after publish, `hogsend upgrade` (never hand-edit package.json), then deal-sold/deal-quoted goal bindings there — separate repo, out of this train.

## Cross-cutting

### Causal labeling contract

- Only holdout-backed numbers carry causal language (`funnels.ts:16`). Enforcement is structural, not editorial: `causal: z.literal(true)` appears only inside holdout-backed blocks (`liftVsControl`, overview `lift`, computed global control, digest lift entries); observational blocks carry `causal: z.literal(false)` (overview `observational`/`attributed`, campaigns section, variant engagement, digest shipped entries). Digest shipped entries structurally CANNOT carry `liftPercent`/`winProbability` (absent from the type). No row-level ambiguous `causal` flag exists anywhere — the overview nests it per block, resolving the two-meanings hazard.
- Suppression is absolute: `suppressed` verdicts render counts + "collecting" copy, never a percentage; `smallSample` warns loudly, never hides.
- Documented observational caveats ride the schemas: cross-version rate comparison (exposure asymmetry — also carried as `firstSeenAt`/`exposureDays` in the digest payload so subscribers can't phrase dishonest comparisons), variant-arm conditioning (arm-vs-holdout clean only for unconditional early calls; arm-vs-arm always clean), salt/percent-rotation crossover in the unversioned overall lift, and the global-control no-userId email-hash approximation.
- The `skipped` global-control state exists so "assignment active, readout absent" is never rendered as "off".

### Replay safety

- All assignment is pure sha256 over stable keys: holdout (`<salt>:<journeyId>:<userId>`), variant (`variant:<journeyId>:<key>:<userId>` — disjoint family, statistically independent). Both hash-input strings and `HASH_INPUT_VERSION` are frozen compatibility contracts locked by golden-value tests.
- Per-enrollment state goes through the recordOnce substrate (`__variants__`): read-first fast path, first-committed-writer-wins, recorded-wins-verbatim across deploys. Version stamps are written only at the three insert sites; replay recovery structurally cannot restamp.
- No clock/RNG in journey code paths; `Date.now()` is legal in the digest cron, where determinism is delivered by the daily dedupeKey + `onConflictDoNothing` fan-out.
- ctx.variant issues zero durable calls (journal-invisible); variant-selected sends need no `ctx.once` wrap; the existing intra-run key-collision throw remains the guard for arm-equals-other-templateKey overlaps.

### Migrations

- Phase 1 (engine track): `0060` — two nullable text columns on `journey_states`, no default, no index, no backfill. Client track untouched; consumers receive it with the engine release.
- Phase 3b (conditional, digest-owned per the recorded deferral): `(journey_id, journey_version_hash)` index on `journey_states` IF Detection A's weekly GROUP BY profiles as a harmful seq scan.
- ctx.variant, goal binding, readouts, Studio: zero migrations. No GIN index on `context` (taxes every journey_states write to serve a rare admin read).

### Webhook catalog sync (`impact.digest`)

Five touch points, hand-synced in one commit: (1) `packages/engine/src/lib/webhook-signing.ts` `WEBHOOK_EVENT_TYPES` + count comment 21→**30**; (2) `packages/engine/src/lib/outbound.ts` payload + exported entry interfaces; (3) `packages/cli/src/commands/webhooks.ts` vendored tuple + its stale "21" comment; (4) `packages/client/src/types.ts` vendored union; (5) `packages/engine/src/destinations/presets/posthog.ts` person-less-event guard (`return null` for `impact.digest`) — and the segment preset skips it too. `routes/admin/webhooks.ts` derives its enum from the engine tuple (no edit).

## Build order & phases

**1a → (1b ∥ 1c ∥ 1d) → 2a → 2b → (3a ∥ 3b) → 4.** Critical path is version stamping only (through 2a's regression fixture and 2b's version timeline); goal binding and ctx.variant could slip a train without blocking phase 2 — the routes degrade to `source: "none"` and `variants: []`.

- **1a — coordinated core edit (D0)**: JourneyMeta version/versionHash/goal; journeyMetaSchema declares those + the missing category + holdout; JourneyContext.variant; registry round-trip test over all five fields. One small PR, zero behavior change.
- **1b ∥ 1c ∥ 1d — engine primitives, parallel (disjoint files)**:
  - 1b VERSION STAMPING (D1): stable-stringify hoist, `journey-version.ts` (with template-literal + regex known-limit tests), migration 0060, defineJourney attach, three-site stamping, blueprint path, admin exposure. Shippable alone (columns fill silently).
  - 1c GOAL BINDING boot half (D3): `has()`, hoisted registry local, fail-closed loop over DEFINED journeys. Route defaulting deliberately deferred to 2a. Shippable alone (boot-throw tests).
  - 1d CTX.VARIANT (D2): `lib/variant.ts`, `__variants__` namespace (engine + harness), `performVariant` with the key-syntax/arms validation split, reserved-key stripping at BOTH seeding sites, harness parity + seed option, skills/docs reserved-key updates. Shippable alone.
- **2a — shared helper + /lift (D4.1–D4.3), sequential**: extract `computeJourneyLift`/`computeLiftValues`, refactor /lift onto them, THEN layer goal resolution + `definitionSource` — one combined regression fixture, plus the ENABLED_JOURNEYS-excluded `"none"` test.
- **2b — /impact + /overview (D4.4–D4.5)** with every correction pinned (zod-4-safe global-control union, states∪ledger journey union, activity-windowed campaigns, per-journey goal WHERE, latest-by-created_at labels, conditioning caveats) AND the Studio-required fields in the wire contract from day one. **Freeze the OpenAPI shapes at the end of 2b.** Phase shippable via curl + OpenAPI + tests, no UI.
- **3a ∥ 3b — parallel tracks (disjoint packages)**:
  - 3a STUDIO (D6): mirror types from the frozen schemas, lift.tsx primitives, journey card, /impact view, nav/route/links; check-types + real-app screenshot pass. Degrades on 404 against older engines.
  - 3b IMPACT DIGEST (D5): workflow on the reconciled helper, watermark, detections incl. new_label, frozen-payload crossing override, concurrency budget, five-point catalog sync + preset guards, env knobs, worker registration, conditional index migration. Inert without subscribers.
- **4 — dogfood + docs, last (same release train, engine merges first)**: 4a apps/api adoption (D7 matrix, experiment, env.example, meta test) + smoke with ~150–200 events or pre-computed in-bucket userIds (a 10% deterministic bucket over 20 events can legitimately hold out zero users); 4b the single consolidated impact.mdx pass, built via `pnpm --filter @hogsend/docs build`; 4c after publish: sibling repo `hogsend upgrade` + deal goal bindings (separate repo, out of this train).

## Testing strategy

**Engine unit** (node:test style, `tsx --test`, for engine-internal files; vitest elsewhere per workspace):

- `journey-version.test.ts`: 12-hex determinism; whitespace/comment invariance (incl. `//` inside string literals NOT stripped); hash changes on trigger/where/entryLimit/exitOn/suppress/holdout/category/goal/body; unchanged on enabled/name/description/version label; meta key-order invariance; `normalizeRunSource` never throws on pathological input (unterminated string/comment, nested template literals, `${...}` containing strings/comments — determinism preserved through the known limits); blueprint-graph body with `https://` URLs and escaped quotes hashes stably; defineJourney attaches/overwrites the hash.
- `variant` unit (`apps/api/src/__tests__/journey-variant.test.ts`, vitest): golden values for 3 fixed inputs (freezes the hash string); distribution over 10k synthetic ids (2 arms 45–55%, 3 arms 28–39% — deterministic, no flake); bucket 9999 → last arm; independence from holdout over 10k ids at 50% holdout; key-syntax RangeErrors (`:`/space/empty/65 chars); arms validation (empty/dupe) fires only via compute; validation precedes durability (spy db untouched); namespace isolation `__once__` vs `__variants__`.

**Core unit**: the D0 registry round-trip suite (five fields; format/bounds rejections).

**API integration** (vitest, `app.request()` + real DB, `apps/api/src/__tests__/`):

- Stamping: enrollment rows carry `journeyVersionHash === meta.versionHash` / label; held_out rows stamped identically; replay recovery with mutated meta keeps the ORIGINAL stamp (no second row, no update); blueprint stamp `v{n}` + graph hash, fork on version bump; admin list/detail/recentStates expose the fields; existing direct `insertEnrollment` calls (no version opts) still pass.
- Goal: boot accept/throw (message contains journey id, bad goal, known-id list; `revenue` hint only when goal is literally `"revenue"`); seeded-revenue valid; seed-opt-out flips validity; DISABLED journeys still validated; ENABLED_JOURNEYS-excluded journey → lift `definitionSource: "none"`; registry round-trip `registry.get(id)?.goal`.
- Variant integration: persistence into `context.__variants__`; recorded-wins replay with a seeded legacy arm (verbatim return, warn-once, no re-warn); replay exactly-once send (one `email_sends` row); re-entry arm stability; held_out rows carry no bag; same-key reuse + `Promise.all` race → single committed arm; reserved-key stripping at both seeding sites (event property `__variants__` never lands in context); arm-equals-templateKey collision still throws; missing-journeyId error; harness parity (byte-equal arms, seed forcing, compile-only literal-union assertion) + context-completeness case.
- /lift regression: one combined fixture — pre-refactor response + `definitionSource` + effective `definitionId`, value arrays included; goal-default precedence (query > goal > none) with converters narrowed per definition.
- /impact + /overview (`admin-impact.test.ts`): 404 vs blueprint-id 200; goal resolution + name; overall `causal: false, verdict: null` with zero controls (no Beta(1,1) ghost); same-hash version control matching (interleaved created_at, NULL-hash bucket, latest-by-created_at label); variants from jsonb (quotes stripped, bag-less + held_out excluded, arm lift vs whole control, null without holdout); per-arm engagement counts vs seeded email_sends; overview union includes ledger-only journeys (observational zeros) and DB-only ids (`registered: false`); goal-scoped converters swap with enrollments intact; single-model credit sums; campaign enumeration catches an old campaign with in-window sends; split_part totals match per-campaign LIKE; globalControl: construction+parse smoke of all three states (the zod-4 landmine test), off/skipped/computed, JS tally equals brute-force `isGlobalControl`, salt rotation changes membership; OpenAPI presence + admin-auth 401.
- Digest (`impact-digest.test.ts`, via exported seams): new_version/new_journey/new_label classification (incl. label-only change with pre-existing hash); pre-window hash silent; cohorts exclude held_out + honor goal + carry firstSeenAt/exposureDays; up/down crossings; already-above-T silent; suppression absolute; smallSample rides; frozen-payload override beats the recompute for prev winProbability; no-subscriber short-circuit; empty → no emit, watermark frozen; dedupe (one delivery row per endpoint per periodKey); watermark derivation + 30d clamp; cap + ordering + truncated; `WEBHOOK_EVENT_TYPES` contains `impact.digest`; posthog/segment presets return null for it. PR checklist item: both vendored catalog copies updated.
- Dogfood: `impact-meta.test.ts` (three assertions, D7).

**Studio**: no automated harness — check-types + lint + the D6 smoke matrix + screenshot pass.

**Smoke (verify-skill pattern)**: fresh DB, real API + worker; ~150–200 `user.created` events (or pre-computed in-bucket userIds via `holdoutBucket()`); assert held_out rows stamped, `__variants__["welcome-subject"]` recorded, `/impact` returns goal + arms + causal flags, a `goal: "not-a-conversion"` journey refuses to boot.

## Explicitly out of scope

- **Campaign holdouts** — campaigns remain correlational-only everywhere (`campaigns.causal: false`); no campaign control cohorts.
- **Runtime holdout dial** — holdout config lives in code (`meta.holdout`); no Studio toggle, no `journey_configs` override, no API mutation.
- **GLOBAL_CONTROL_PERCENT in dogfood** — stays `0` (documented in `.env.example`); at dogfood volume a global cohort never clears the small-sample floor and suppresses lifecycle mail owed to customers. Per-journey holdout is the workhorse.
- `ctx.variant` **weights** — deferred with the re-entry/readout semantics documented above.
- **Template-registry hash fold** — folding rendered-template hashes into `computeJourneyVersionHash` is the real fix for template-edit invisibility; v1 ships the label practice + `new_label` digest signal instead.
- **Blueprint `meta.goal`** — blueprints cannot declare a persisted goal (code-first law); documented boundary, per-request `definitionId` is the only override.
- **Digest in-product surface** — a Studio "recent changes" strip is a candidate follow-up; v1 is webhook-only by design.
- **Cached global-control materialization** — the >500k `skipped` state is the honest ceiling; a cron-materialized readout is deferred.
- **Studio `variant` graph node** (renders as `unknown` — cosmetic), **GIN index on `context`**, **`conversions (user_key, occurred_at)` index** (profile-first), **400 on unknown explicit `definitionId`** (kept silent), **`user-activated` milestone conversion** (5-line follow-up), **sibling-repo deal goal bindings** (separate repo/train).

## Open questions

None. Every decision the component designs or reviews left open has been resolved in this document per house laws: hash excludes `name`/`description` (display-only; frozen at first release, D1); ctx.variant ships equal-split only (D2); explicit unknown `definitionId` stays silent (D3); overview attribution model defaults to `linear` (D4.5); `ENABLE_IMPACT_DIGEST` dropped and the posthog/segment presets skip `impact.digest` (D5); the Studio nav entry ships with the routes (D6); dogfood stays revenue-only with the milestone conversion deferred, and deal goals bind in the sibling repo (D7).