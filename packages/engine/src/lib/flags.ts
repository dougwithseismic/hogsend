import { createHash } from "node:crypto";
import type { FlagVariant, PropertyCondition } from "@hogsend/core";
import { evaluatePropertyConditions } from "@hogsend/core";
import { contacts, type Database, flags } from "@hogsend/db";
import { and, eq, isNull } from "drizzle-orm";

/**
 * The structural subset of a flag the evaluator reads. Both the drizzle row
 * (`flags.$inferSelect`) and the portable `FlagDefinition` (@hogsend/core)
 * satisfy it, so the same pure function serves the DB path and any in-memory
 * caller.
 */
export interface EvaluableFlag {
  key: string;
  enabled: boolean;
  type: string;
  variants: FlagVariant[];
  defaultValue: unknown;
  targeting: PropertyCondition[];
  rollout: number;
}

/**
 * Deterministic percent bucket in [0, 100) from a string. Mirrors the holdout
 * hashing law (sha256's first 4 bytes → uniform bucket): NO RNG and NO clock,
 * so the same input buckets identically forever. A contact is IN the rollout
 * when `bucket < rollout` (see {@link evaluateFlag}).
 */
export function flagBucket(input: string): number {
  const digest = createHash("sha256").update(input).digest();
  return (digest.readUInt32BE(0) % 10000) / 100;
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
 * Evaluate ONE flag for a contact. STICKY by construction — the result is a
 * pure function of `contactKey` + the flag definition, so there is no per-user
 * assignment storage. Precedence:
 *   1. disabled            → defaultValue
 *   2. targeting fails     → defaultValue (empty targeting = everyone matches)
 *   3. outside the rollout → defaultValue
 *   4. boolean flag        → true
 *   5. multivariate        → the picked variant's value
 */
export function evaluateFlag(
  flag: EvaluableFlag,
  ctx: { contactKey: string; properties: Record<string, unknown> },
): unknown {
  if (!flag.enabled) return flag.defaultValue;

  if (
    flag.targeting.length > 0 &&
    !evaluatePropertyConditions({
      conditions: flag.targeting,
      properties: ctx.properties,
    })
  ) {
    return flag.defaultValue;
  }

  if (flagBucket(`${ctx.contactKey}:${flag.key}`) >= flag.rollout) {
    return flag.defaultValue;
  }

  if (flag.type === "boolean") return true;
  return pickVariant(flag, ctx.contactKey);
}

/**
 * Evaluate EVERY live (enabled, non-archived) flag for a contact and return the
 * `{ key: value }` map. `contactKey` is the STICKY bucketing identity ONLY.
 * Targeting properties are loaded from `contactId` — the SERVER-TRUSTED
 * `contacts.id` that `resolveFeedRecipient` already resolved for the request —
 * NEVER by re-resolving the raw `contactKey`.
 *
 * This split is a security boundary: a publishable (pk_) caller's `contactKey`
 * is its RAW anon id, which it fully controls. Re-resolving that raw value
 * (`resolveContact({ id: contactKey })`) would match `contacts.id` on a uuid or
 * `external_id` on a string — letting a pk_ caller who passes a victim's
 * internal contact uuid (or external id) as `anonymousId` load the VICTIM's
 * properties and read their targeting-gated flag membership. `contactId`, by
 * contrast, is only ever the caller's OWN anon contact (matched via
 * `anonymous_id`) or a token/secret-verified contact. Absent `contactId` ⇒
 * empty properties — targeting-gated flags fall to default, ungated flags still
 * bucket deterministically on `contactKey`.
 */
export async function evaluateFlagsForContact(opts: {
  db: Database;
  contactKey: string;
  contactId?: string;
}): Promise<Record<string, unknown>> {
  const { db, contactKey, contactId } = opts;

  const rows = await db
    .select()
    .from(flags)
    .where(and(eq(flags.enabled, true), isNull(flags.archivedAt)));

  const contact = contactId
    ? (
        await db
          .select({ properties: contacts.properties })
          .from(contacts)
          .where(and(eq(contacts.id, contactId), isNull(contacts.deletedAt)))
          .limit(1)
      )[0]
    : undefined;
  const properties = (contact?.properties ?? {}) as Record<string, unknown>;

  const result: Record<string, unknown> = {};
  for (const flag of rows) {
    result[flag.key] = evaluateFlag(flag, { contactKey, properties });
  }
  return result;
}
