import { type Database, journeyStates } from "@hogsend/db";
import { eq, sql } from "drizzle-orm";

/** The reserved `journey_states.context` sub-bags a record-once value can live
 * under. A closed union — the ONLY values reachable at the SQL path, so the
 * token can be interpolated into the jsonb path (see {@link recordOnce}) while
 * `key`/value stay bound parameters. */
export type RecordNamespace =
  | "__once__"
  | "__digest__"
  | "__throttle__"
  | "__variants__"
  | "__groupKeys__";

// Closed-union → validated path token. NOT user input: only these five literals
// reach the interpolated jsonb path below, so it is injection-safe. `key` and the
// JSON-stringified value are ALWAYS bound parameters regardless.
const NAMESPACE_TOKEN: Record<RecordNamespace, string> = {
  __once__: "__once__",
  __digest__: "__digest__",
  __throttle__: "__throttle__",
  __variants__: "__variants__",
  __groupKeys__: "__groupKeys__",
};

/** Extract the `(namespace)` sub-bag from an already-fetched context, `{}` when
 * absent — {@link recordOnce}'s read-first fast path. */
function namespaceBag(
  context: unknown,
  namespace: RecordNamespace,
): Record<string, unknown> {
  const ctxBag = (context ?? {}) as Record<string, unknown>;
  return (ctxBag[namespace] ?? {}) as Record<string, unknown>;
}

/**
 * Durable set-once for a single `(stateId, namespace, key)` — the replay-safety
 * primitive shared by `ctx.once`, `ctx.digest`, `ctx.throttle`, and the
 * journey-suppress guard. Guarantees:
 *
 * - **Set-once**: the first committed write for a `(stateId, namespace, key)`
 *   wins; `compute` runs at most once per winning writer and never again once a
 *   value is recorded (a replay-from-top re-reads the stored value).
 * - **First-writer-wins under a concurrent race**: a zombie double-writer (a
 *   partitioned worker's original execution racing its replay) CANNOT clobber a
 *   value the winner already returned to author code. The persist uses a
 *   FIRST-writer-wins jsonb merge and returns the value from the UPDATE's
 *   RETURNING (the post-merge committed row), so both racers observe the SAME
 *   (first-committed) value even if the loser computed something different.
 *
 * Values MUST be JSON-serializable (stored in a jsonb column, round-tripped
 * through `JSON.stringify`/Postgres jsonb).
 */
export async function recordOnce<T>(opts: {
  db: Database;
  stateId: string;
  namespace: RecordNamespace;
  key: string;
  compute: () => Promise<T> | T;
}): Promise<T> {
  const { db, stateId, namespace, key, compute } = opts;
  if (!Object.hasOwn(NAMESPACE_TOKEN, namespace)) {
    throw new Error(`recordOnce: unknown namespace "${namespace}"`);
  }
  const token = NAMESPACE_TOKEN[namespace];

  // Read the current state row's context and return `context[namespace][key]`
  // when already recorded (an earlier writer, or a replay-from-top) WITHOUT
  // re-running `compute`.
  const row = await db.query.journeyStates.findFirst({
    where: eq(journeyStates.id, stateId),
    columns: { context: true },
  });
  const bag = namespaceBag(row?.context, namespace);
  if (Object.hasOwn(bag, key)) {
    return bag[key] as T;
  }

  const value = await compute();
  // Persist under context.<namespace>.<key>. jsonb_set with create_missing=true
  // cannot create a NESTED key whose parent object is absent (a fresh '{}' has no
  // '<namespace>'), so we set the TOP-LEVEL '<namespace>' to the single new key
  // MERGED with its existing bag — creating '<namespace>' when missing AND
  // preserving sibling keys. The merge is FIRST-writer-wins: `a || b` lets b's
  // keys win on conflict, so the EXISTING bag sits on the RIGHT — a concurrent
  // writer that committed `key` first is NOT clobbered by this write. `key` and
  // the value are bound parameters (jsonb_build_object), so the write is
  // injection-safe; the namespace token is a validated closed-union literal.
  //
  // RETURNING hands back the POST-merge committed row in the same round-trip: a
  // blocked concurrent loser re-evaluates the SET against the winner's committed
  // tuple (existing bag wins the merge) and RETURNING yields the winner's value —
  // byte-identical to a separate read-back, one query cheaper.
  const [updated] = await db
    .update(journeyStates)
    .set({
      context: sql`jsonb_set(
        coalesce(${journeyStates.context}, '{}'::jsonb),
        ${sql.raw(`'{${token}}'`)},
        jsonb_build_object(${key}::text, ${JSON.stringify(value ?? null)}::jsonb)
          || coalesce(${journeyStates.context} -> ${sql.raw(`'${token}'`)}, '{}'::jsonb),
        true
      )`,
      updatedAt: new Date(),
    })
    .where(eq(journeyStates.id, stateId))
    .returning({ context: journeyStates.context });

  // Return the committed value — never the locally computed one. Fall back to
  // the computed value only if the row vanished mid-flight (deleted
  // concurrently: 0 rows updated).
  const after = namespaceBag(updated?.context, namespace);
  if (Object.hasOwn(after, key)) {
    return after[key] as T;
  }
  return value;
}

/**
 * Drop ALL reserved record-once namespace keys from an event-properties bag.
 * Enrollment seeds `journey_states.context` from trigger-event properties
 * (execute-journey-run.ts — BOTH the fresh-entry and held_out inserts);
 * without this strip a publishable-key browser event carrying e.g.
 * `__variants__` could pre-fill a reserved bag — choosing its own ctx.variant
 * arm AND injecting arbitrary strings into the impact readout's GROUP BY
 * dimension. One filter protects every bag at once. Engine-supplied
 * `extraContext` (e.g. `__blueprintVersion`) is deliberately NOT passed
 * through this filter.
 */
export function stripRecordNamespaces<T>(
  properties: Record<string, T>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(properties).filter(
      ([key]) => !Object.hasOwn(NAMESPACE_TOKEN, key),
    ),
  ) as Record<string, T>;
}
