import { type SQL, sql } from "drizzle-orm";

/**
 * Transaction-scoped advisory lock serializing a blueprint's graph EDIT
 * (`updateBlueprint`'s in-flight count + guarded update) against a new
 * ENROLLMENT insert for the same blueprint (`insertEnrollment` for a blueprint
 * run). Both sides take THIS lock inside their transaction, so the count and
 * the insert cannot interleave: an enrollment either lands before the count
 * (the edit then sees it and rejects with `in_flight`) or after the graph
 * commits (a fresh run walking the NEW graph) — never mid-flight, which is the
 * interleaving that would desync the positional Hatchet replay journal for a
 * run suspended between the count and the update.
 *
 * `hashtext` folds the id into the int4 the single-arg `pg_advisory_xact_lock`
 * overload casts to bigint (same pattern as `contacts.ts`/`boot-api-key.ts`);
 * the `bp-graph:` prefix namespaces it away from the codebase's other advisory
 * locks. Xact-scoped — released on commit/rollback, no manual unlock.
 */
export function blueprintGraphLock(blueprintId: string): SQL {
  return sql`SELECT pg_advisory_xact_lock(hashtext(${`bp-graph:${blueprintId}`}))`;
}
