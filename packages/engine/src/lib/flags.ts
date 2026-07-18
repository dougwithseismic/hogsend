import { createHash } from "node:crypto";
import type {
  ConditionEval,
  ConditionSet,
  FlagTargeting,
  FlagVariant,
  PropertyCondition,
} from "@hogsend/core";
import { evaluateCondition, evaluatePropertyConditions } from "@hogsend/core";
import {
  bucketMemberships,
  contacts,
  type Database,
  deals,
  flags,
  journeyStates,
} from "@hogsend/db";
import { and, eq, isNull } from "drizzle-orm";

/**
 * The structural subset of a flag the evaluator reads. Both the drizzle row
 * (`flags.$inferSelect`) and the portable `FlagDefinition` (@hogsend/core)
 * satisfy it, so the same pure function serves the DB path and any in-memory
 * caller. `targeting` accepts BOTH the legacy `PropertyCondition[]` (implicit
 * AND) and the condition tree ({@link FlagTargeting}); `conditionSets` is the
 * richer ordered form (first matching set wins) and, when present, takes
 * precedence over `targeting`+`rollout`.
 */
export interface EvaluableFlag {
  key: string;
  enabled: boolean;
  type: string;
  variants: FlagVariant[];
  defaultValue: unknown;
  targeting: FlagTargeting | PropertyCondition[];
  rollout: number;
  conditionSets?: ConditionSet[] | null;
}

/**
 * The FIXED, snapshot of the materialized contact state the pure targeting
 * leaves read. Loaded ONCE per flag evaluation request (never per flag), so the
 * browser `GET /v1/flags` hot path stays O(1) in the number of flags:
 *   - `properties` — the contact's stored properties (property leaves)
 *   - `email`      — the contact's email, the key `email_engagement` scan leaves
 *                    look up `email_sends` on (SERVER path only; `contactKey` is
 *                    NOT an email, so without this the leaf never matches)
 *   - `buckets`    — the ids of the contact's ACTIVE bucket memberships
 *   - `journeys`   — per journey id, whether it is live (active/waiting) and/or
 *                    has completed
 *   - `deals`      — the contact's CRM deal posture (won/open + furthest stage)
 */
export interface TargetingSnapshot {
  properties: Record<string, unknown>;
  email: string | null;
  buckets: Set<string>;
  journeys: Map<string, { active: boolean; completed: boolean }>;
  deals: { won: boolean; open: boolean; stage: string | null };
}

/** An empty snapshot (anon contact / no materialized rows). */
export function emptySnapshot(
  properties: Record<string, unknown> = {},
): TargetingSnapshot {
  return {
    properties,
    email: null,
    buckets: new Set(),
    journeys: new Map(),
    deals: { won: false, open: false, stage: null },
  };
}

/**
 * Load the FIXED ~4-query targeting snapshot for a contact. `contactKey` is the
 * logical id `bucket_memberships`/`journey_states` are keyed on (their `userId`
 * is `external_id ?? anonymous_id ?? id`); `contactId` is the trusted uuid used
 * for the property + deal reads (see `evaluateFlagsForContact`'s security note).
 * An anon contact with no rows yields empty sets — correct (targeting-gated
 * flags fall to default).
 */
export async function loadTargetingSnapshot(opts: {
  db: Database;
  contactKey: string;
  contactId?: string;
}): Promise<TargetingSnapshot> {
  const { db, contactKey, contactId } = opts;

  const [contactRows, bucketRows, journeyRows, dealRows] = await Promise.all([
    contactId
      ? db
          .select({ properties: contacts.properties, email: contacts.email })
          .from(contacts)
          .where(and(eq(contacts.id, contactId), isNull(contacts.deletedAt)))
          .limit(1)
      : Promise.resolve([] as { properties: unknown; email: string | null }[]),
    db
      .select({ bucketId: bucketMemberships.bucketId })
      .from(bucketMemberships)
      .where(
        and(
          eq(bucketMemberships.userId, contactKey),
          eq(bucketMemberships.status, "active"),
          isNull(bucketMemberships.deletedAt),
        ),
      ),
    db
      .select({
        journeyId: journeyStates.journeyId,
        status: journeyStates.status,
      })
      .from(journeyStates)
      .where(eq(journeyStates.userId, contactKey)),
    contactId
      ? db
          .select({
            soldAt: deals.soldAt,
            canonicalStage: deals.canonicalStage,
            stageRank: deals.stageRank,
          })
          .from(deals)
          .where(eq(deals.contactId, contactId))
      : Promise.resolve(
          [] as {
            soldAt: Date | null;
            canonicalStage: string;
            stageRank: number;
          }[],
        ),
  ]);

  const properties = (contactRows[0]?.properties ?? {}) as Record<
    string,
    unknown
  >;
  const email = (contactRows[0]?.email ?? null) as string | null;

  const buckets = new Set<string>();
  for (const row of bucketRows) buckets.add(row.bucketId);

  const journeys = new Map<string, { active: boolean; completed: boolean }>();
  for (const row of journeyRows) {
    const entry = journeys.get(row.journeyId) ?? {
      active: false,
      completed: false,
    };
    if (row.status === "active" || row.status === "waiting") {
      entry.active = true;
    }
    if (row.status === "completed") entry.completed = true;
    journeys.set(row.journeyId, entry);
  }

  let won = false;
  let open = false;
  let stage: string | null = null;
  let bestRank = -1;
  for (const row of dealRows) {
    if (row.soldAt != null || row.canonicalStage === "sold") won = true;
    if (row.canonicalStage !== "sold" && row.canonicalStage !== "lost") {
      open = true;
    }
    // The furthest-along deal represents the contact's stage for a `stage`
    // predicate (denormalized `stageRank`, highest wins).
    if (row.stageRank > bestRank) {
      bestRank = row.stageRank;
      stage = row.canonicalStage;
    }
  }

  return { properties, email, buckets, journeys, deals: { won, open, stage } };
}

/**
 * The context an async targeting evaluation runs in. `mode` gates the SERVER-
 * ONLY scan leaves (`event`/`email_engagement`): they resolve via
 * `evaluateCondition` ONLY when `mode==="server"` with `db`+`userId`, and
 * short-circuit to `false` on the browser path (keeping the browser query count
 * fixed — no per-flag DB access).
 */
export interface TargetingEvalContext {
  snapshot: TargetingSnapshot;
  mode: "browser" | "server";
  db?: Database;
  userId?: string;
}

/**
 * A `negate`-aware answer for the pure snapshot leaves.
 */
function applyNegate(matched: boolean, negate?: boolean): boolean {
  return negate ? !matched : matched;
}

/**
 * Evaluate a PURE (snapshot-backed, DB-free) targeting leaf. Returns `null` for
 * a leaf that is NOT pure (`event`/`email_engagement`) so the caller can route
 * it to the server-only path.
 */
function evaluatePureLeaf(
  node: Exclude<FlagTargeting, { type: "composite" }>,
  snapshot: TargetingSnapshot,
): boolean | null {
  switch (node.type) {
    case "property":
      return evaluatePropertyConditions({
        conditions: [node],
        properties: snapshot.properties,
      });
    case "bucket":
      return applyNegate(snapshot.buckets.has(node.bucketId), node.negate);
    case "journey": {
      const entry = snapshot.journeys.get(node.journeyId);
      const matched =
        node.state === "active" ? !!entry?.active : !!entry?.completed;
      return applyNegate(matched, node.negate);
    }
    case "deal": {
      let matched: boolean;
      if (node.predicate === "won") matched = snapshot.deals.won;
      else if (node.predicate === "open") matched = snapshot.deals.open;
      else matched = node.stage != null && snapshot.deals.stage === node.stage;
      return applyNegate(matched, node.negate);
    }
    default:
      // event / email_engagement — not snapshot-resolvable.
      return null;
  }
}

/**
 * Fully evaluate a targeting node against the snapshot + mode. PURE leaves
 * resolve from the snapshot; the SERVER-ONLY scan leaves resolve via
 * `evaluateCondition` on the server path (else `false`); a COMPOSITE folds
 * AND/OR (short-circuiting) over its children. A bare `PropertyCondition[]` is
 * an implicit AND (empty ⇒ everyone); an empty COMPOSITE ⇒ everyone.
 */
export async function evaluateTargeting(
  node: FlagTargeting | PropertyCondition[] | null | undefined,
  ctx: TargetingEvalContext,
): Promise<boolean> {
  if (node == null) return true;
  if (Array.isArray(node)) {
    for (const child of node) {
      if (!(await evaluateTargeting(child, ctx))) return false;
    }
    return true;
  }
  if (node.type === "composite") {
    // An empty group is "no constraint" ⇒ everyone, regardless of operator.
    if (node.conditions.length === 0) return true;
    if (node.operator === "or") {
      for (const child of node.conditions) {
        if (await evaluateTargeting(child, ctx)) return true;
      }
      return false;
    }
    for (const child of node.conditions) {
      if (!(await evaluateTargeting(child, ctx))) return false;
    }
    return true;
  }

  const pure = evaluatePureLeaf(node, ctx.snapshot);
  if (pure !== null) return pure;

  // event / email_engagement — SERVER-ONLY. Never touches the DB on the browser
  // path (THE invariant): short-circuit to false unless server mode is armed.
  if (ctx.mode !== "server" || !ctx.db || !ctx.userId) return false;
  return evaluateCondition({
    condition: node as ConditionEval,
    ctx: {
      db: ctx.db,
      userId: ctx.userId,
      // `email_engagement` leaves look up `email_sends.to_email` — key it on the
      // contact's ACTUAL email (from the loaded snapshot), never the contactKey
      // (which is external_id/anonymous_id/id, never an address).
      email: ctx.snapshot.email,
      journeyContext: {},
    },
  });
}

/**
 * Deterministic percent bucket in [0, 100) from a string. Mirrors the holdout
 * hashing law (sha256's first 4 bytes → uniform bucket): NO RNG and NO clock,
 * so the same input buckets identically forever. A contact is IN a set's
 * rollout when `bucket < set.rollout` (see {@link evaluateFlag}).
 */
export function flagBucket(input: string): number {
  const digest = createHash("sha256").update(input).digest();
  return (digest.readUInt32BE(0) % 10000) / 100;
}

/**
 * The rollout admission-hash input for condition set index `i`. Set 0 — the
 * synthesized back-compat set of a legacy flag AND the first set of any flag —
 * keys on the bare `${contactKey}:${flagKey}` so a pre-condition-set flag keeps
 * its EXACT pre-Phase-2 bucket across the upgrade (rollout stays STICKY, no
 * silent re-randomization). Additional sets append `:${i}`, giving each set's
 * rollout an INDEPENDENT dice roll (a contact that fails set 0's rollout can
 * still pass set 1's). Used identically by the sync and async evaluators.
 */
function rolloutKey(contactKey: string, flagKey: string, i: number): string {
  return i === 0 ? `${contactKey}:${flagKey}` : `${contactKey}:${flagKey}:${i}`;
}

/**
 * Deterministic unit in [0, 1) from a string — the weighted-variant selector.
 * Same sha256-first-4-bytes construction as {@link flagBucket}, normalized over
 * the full 32-bit range so the multivariate pick is uniform.
 */
export function flagUnit(input: string): number {
  const digest = createHash("sha256").update(input).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

/**
 * Pick a multivariate arm by cumulative weight over a deterministic unit-hash
 * of `contactKey:flagKey:v`. Weights are relative (normalized by their sum);
 * a zero/empty weight set falls back to the flag's `defaultValue`.
 */
function pickVariant(flag: EvaluableFlag, contactKey: string): unknown {
  const total = flag.variants.reduce((s, v) => s + Math.max(0, v.weight), 0);
  if (total <= 0) return flag.defaultValue;
  const target = flagUnit(`${contactKey}:${flag.key}:v`) * total;
  let cumulative = 0;
  for (const variant of flag.variants) {
    cumulative += Math.max(0, variant.weight);
    if (target < cumulative) return variant.value;
  }
  // Floating-point tail: fall through to the last arm.
  return flag.variants[flag.variants.length - 1]?.value ?? flag.defaultValue;
}

/**
 * The ordered condition sets to walk for a flag. When `conditionSets` is present
 * and non-empty it is authoritative; otherwise a single set is synthesized from
 * the legacy `targeting`+`rollout` columns (back-compat: a flag that predates
 * condition sets, or an empty array ⇒ one everyone-set at the flag's rollout).
 */
function resolveConditionSets(flag: EvaluableFlag): ConditionSet[] {
  if (flag.conditionSets && flag.conditionSets.length > 0) {
    return flag.conditionSets;
  }
  return [{ targeting: flag.targeting, rollout: flag.rollout }];
}

/**
 * The served value once a matching set (or none) is known. Shared by the sync
 * (browser-pure) and async (mode-aware) entry points.
 */
function servedValue(flag: EvaluableFlag, contactKey: string): unknown {
  if (flag.type === "boolean") return true;
  return pickVariant(flag, contactKey);
}

/**
 * SYNC, browser-pure evaluation of a flag for a contact. PURE leaves
 * (property/bucket/journey/deal) resolve from `snapshot` (or, back-compat, from
 * bare `properties`); the SERVER-ONLY scan leaves (event/email_engagement)
 * evaluate to `false`. STICKY by construction. Precedence — walk the ordered
 * condition sets; the FIRST set whose targeting matches AND whose per-set
 * rollout bucket ({@link rolloutKey}) admits the contact wins; otherwise
 * `defaultValue`.
 */
export function evaluateFlag(
  flag: EvaluableFlag,
  ctx: {
    contactKey: string;
    properties: Record<string, unknown>;
    snapshot?: TargetingSnapshot;
  },
): unknown {
  if (!flag.enabled) return flag.defaultValue;

  const snapshot = ctx.snapshot ?? emptySnapshot(ctx.properties);
  const sets = resolveConditionSets(flag);
  for (let i = 0; i < sets.length; i++) {
    const set = sets[i];
    if (!set) continue;
    if (!evaluateTargetingSync(set.targeting, snapshot)) continue;
    if (flagBucket(rolloutKey(ctx.contactKey, flag.key, i)) >= set.rollout) {
      continue;
    }
    return servedValue(flag, ctx.contactKey);
  }
  return flag.defaultValue;
}

/**
 * SYNC targeting fold used by the browser-pure {@link evaluateFlag}. Identical
 * semantics to the async {@link evaluateTargeting} in `mode:"browser"` (the
 * server-only scan leaves are `false`), but without the Promise machinery.
 */
function evaluateTargetingSync(
  node: FlagTargeting | PropertyCondition[] | null | undefined,
  snapshot: TargetingSnapshot,
): boolean {
  if (node == null) return true;
  if (Array.isArray(node)) {
    return node.every((child) => evaluateTargetingSync(child, snapshot));
  }
  if (node.type === "composite") {
    if (node.conditions.length === 0) return true;
    return node.operator === "or"
      ? node.conditions.some((c) => evaluateTargetingSync(c, snapshot))
      : node.conditions.every((c) => evaluateTargetingSync(c, snapshot));
  }
  const pure = evaluatePureLeaf(node, snapshot);
  // event / email_engagement are server-only ⇒ false on the browser path.
  return pure ?? false;
}

/**
 * Async, mode-aware evaluation of one flag against a pre-loaded snapshot. On the
 * browser path this NEVER issues a DB query (server-only leaves short-circuit to
 * false); on the server path event/email_engagement leaves resolve via
 * `evaluateCondition`. First matching set wins (per-set rollout keyed by index).
 */
async function evaluateFlagResolved(
  flag: EvaluableFlag,
  ctx: {
    contactKey: string;
    snapshot: TargetingSnapshot;
    mode: "browser" | "server";
    db?: Database;
    userId?: string;
  },
): Promise<unknown> {
  if (!flag.enabled) return flag.defaultValue;

  const evalCtx: TargetingEvalContext = {
    snapshot: ctx.snapshot,
    mode: ctx.mode,
    db: ctx.db,
    userId: ctx.userId,
  };
  const sets = resolveConditionSets(flag);
  for (let i = 0; i < sets.length; i++) {
    const set = sets[i];
    if (!set) continue;
    if (!(await evaluateTargeting(set.targeting, evalCtx))) continue;
    if (flagBucket(rolloutKey(ctx.contactKey, flag.key, i)) >= set.rollout) {
      continue;
    }
    return servedValue(flag, ctx.contactKey);
  }
  return flag.defaultValue;
}

/**
 * Evaluate EVERY live (enabled, non-archived) flag for a contact and return the
 * `{ key: value }` map. `contactKey` is the STICKY bucketing identity AND the
 * key `bucket_memberships`/`journey_states`/`user_events` are read on; the
 * SERVER-TRUSTED `contactId` (a resolved `contacts.id`, NEVER a re-resolved raw
 * `contactKey`) scopes the property + deal reads — the same security boundary as
 * before (a pk_ caller's raw `contactKey` must never load another contact's
 * properties/deals).
 *
 * THE INVARIANT: the snapshot is loaded ONCE (a fixed ~4 indexed queries) and
 * every flag evaluates against it, so the browser path issues a FIXED query
 * count (flags query + snapshot) regardless of flag count. On `mode:"browser"`
 * the server-only scan leaves (event/email_engagement) short-circuit to false —
 * NO per-flag DB query runs. `mode:"server"` (the secret-key evaluate route)
 * resolves those leaves via `evaluateCondition` keyed on `contactKey`.
 */
export async function evaluateFlagsForContact(opts: {
  db: Database;
  contactKey: string;
  contactId?: string;
  mode: "browser" | "server";
}): Promise<Record<string, unknown>> {
  const { db, contactKey, contactId, mode } = opts;

  const rows = await db
    .select()
    .from(flags)
    .where(and(eq(flags.enabled, true), isNull(flags.archivedAt)));

  const snapshot = await loadTargetingSnapshot({ db, contactKey, contactId });

  const result: Record<string, unknown> = {};
  for (const row of rows) {
    // The jsonb `targeting`/`conditionSets` columns are typed loosely at rest
    // (db can't import core; Zod validates on write). Narrow to the evaluated
    // shape at this single boundary, matching `serializeFlag`.
    const flag = row as unknown as EvaluableFlag;
    result[flag.key] = await evaluateFlagResolved(flag, {
      contactKey,
      snapshot,
      mode,
      db: mode === "server" ? db : undefined,
      userId: mode === "server" ? contactKey : undefined,
    });
  }
  return result;
}
