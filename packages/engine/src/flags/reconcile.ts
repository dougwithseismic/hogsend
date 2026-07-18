/**
 * Boot-time reconciler for code-defined feature flags ({@link defineFlag}).
 *
 * Runs once at container build (in BOTH the API and worker processes),
 * fire-and-forget and best-effort — a single malformed definition warns and is
 * skipped; the reconciler NEVER throws and never fails boot. State stays
 * DB-owned: this only writes the CONTRACT (identity + served shape). Per
 * definition (deduped on key):
 *
 *  - No live row → INSERT the contract fields with `origin:"code"`, born OFF
 *    (`enabled:false` — the DB column defaults to `true`, so this MUST be set
 *    explicitly) and inert (`rollout:0`, `targeting:[]`, `conditionSets:[]`).
 *    The insert is `onConflictDoNothing` against the partial-unique live-key
 *    index, so two replicas reconciling concurrently is safe.
 *  - Live row with `origin:"code"` → sync CONTRACT drift ONLY (name /
 *    description / type / variants / defaultValue) via a canonical-JSON diff.
 *    Operator STATE (enabled / rollout / targeting / conditionSets) is NEVER
 *    touched — an operator who turned the flag on and set a rollout keeps it.
 *  - Live row with a non-`code` origin (e.g. a Studio-authored "native" flag
 *    that happens to share the key) → LEFT untouched + a warn. Code never
 *    steals an operator's flag.
 *  - A flag removed from code → not iterated → left exactly as-is (no
 *    auto-archive).
 */
import type { DefinedFlag } from "@hogsend/core";
import { flags } from "@hogsend/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { HogsendClient } from "../container.js";

export interface FlagReconcileResult {
  created: number;
  updated: number;
  skipped: number;
}

export async function reconcileDefinedFlags(opts: {
  client: HogsendClient;
  flags: DefinedFlag[];
}): Promise<FlagReconcileResult> {
  const { client } = opts;
  const { db, logger } = client;
  const result: FlagReconcileResult = { created: 0, updated: 0, skipped: 0 };
  const seen = new Set<string>();

  for (const def of opts.flags) {
    const meta = def.meta;
    const key = meta.key;

    if (seen.has(key)) {
      logger.warn("flags: duplicate defineFlag key — skipping", { key });
      result.skipped++;
      continue;
    }
    seen.add(key);

    // The contract projection, resolved once. `defaultValue` defaults to the
    // type's natural empty (false for boolean, null for multivariate) — never
    // relying on the DB column default so the row matches the definition
    // byte-for-byte.
    const variants = [...(meta.variants ?? [])];
    const defaultValue =
      meta.defaultValue ?? (meta.type === "boolean" ? false : null);
    const description = meta.description ?? null;

    try {
      const existingRows = await db
        .select({
          id: flags.id,
          origin: flags.origin,
          name: flags.name,
          description: flags.description,
          type: flags.type,
          variants: flags.variants,
          defaultValue: flags.defaultValue,
        })
        .from(flags)
        .where(and(eq(flags.key, key), isNull(flags.archivedAt)))
        .limit(1);
      const existing = existingRows[0];

      if (!existing) {
        const inserted = await db
          .insert(flags)
          .values({
            key,
            name: meta.name,
            description,
            // The DB column defaults to `true`; a defined flag is born OFF
            // (unless the definition seeds `enabled:true`) so a deploy never
            // silently flips live traffic. Explicit by contract.
            enabled: meta.enabled ?? false,
            type: meta.type,
            variants,
            defaultValue,
            targeting: [],
            rollout: 0,
            conditionSets: [],
            origin: "code",
          })
          // The loser of a two-replica insert race defers to the winner. The
          // `where` predicate MUST match the partial-unique index
          // (`flags_key_unique_idx WHERE archived_at IS NULL`) or Postgres
          // cannot infer the conflict arbiter (42P10).
          .onConflictDoNothing({
            target: flags.key,
            where: sql`archived_at is null`,
          })
          .returning({ id: flags.id });

        if (inserted[0]) {
          logger.info("flags: defined flag created (disabled)", { key });
          result.created++;
        } else {
          result.skipped++;
        }
        continue;
      }

      // A same-key flag owned by an operator/Studio (origin != "code") is never
      // clobbered by a code definition — leave it and warn.
      if (existing.origin !== "code") {
        logger.warn(
          "flags: key already owned by a non-code flag — leaving it untouched",
          { key, origin: existing.origin },
        );
        result.skipped++;
        continue;
      }

      const changed =
        existing.name !== meta.name ||
        (existing.description ?? null) !== description ||
        existing.type !== meta.type ||
        canonicalJson(existing.variants ?? []) !== canonicalJson(variants) ||
        canonicalJson(existing.defaultValue ?? null) !==
          canonicalJson(defaultValue);

      if (!changed) {
        result.skipped++;
        continue;
      }

      // Contract drift only. STATE columns (enabled / rollout / targeting /
      // conditionSets) are deliberately absent from this SET. The CAS on
      // `origin = "code"` keeps an operator who flipped provenance mid-flight
      // from being overwritten.
      await db
        .update(flags)
        .set({
          name: meta.name,
          description,
          type: meta.type,
          variants,
          defaultValue,
          updatedAt: new Date(),
        })
        .where(and(eq(flags.id, existing.id), eq(flags.origin, "code")));

      logger.info("flags: defined flag contract synced", { key });
      result.updated++;
    } catch (err) {
      // One bad definition must never take down boot for every other flag.
      logger.warn("flags: reconcile failed for definition — skipping", {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      result.skipped++;
    }
  }

  return result;
}

/**
 * Key-order-canonical JSON for the changed-comparison. `existing.variants` /
 * `existing.defaultValue` round-trip through Postgres jsonb, which does NOT
 * preserve object key order, so a plain `JSON.stringify` would report a phantom
 * "changed" for any multi-key object — rewriting (and logging) an unchanged
 * definition on every boot. Arrays keep order; only object keys are sorted.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, entry]) => [k, sortKeysDeep(entry)]),
    );
  }
  return value;
}
