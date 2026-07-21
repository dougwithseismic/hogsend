import { type Database, groupMemberships, groups } from "@hogsend/db";
import { and, eq, isNull } from "drizzle-orm";
import { readRecordedValue, recordOnce } from "./record-once.js";

/**
 * Thrown when a group-scoped primitive cannot pin its scope to a single group
 * key: the enrolled contact has no live membership of the requested type, has
 * more than one (ambiguous), or no contact was resolvable at all. A loud throw
 * (not a silent skip) — an unresolvable scope is an authoring/data problem the
 * journey must surface, exactly like an intra-run key collision.
 */
export class GroupScopeUnresolvableError extends Error {
  readonly journeyId: string;
  readonly groupType: string;

  constructor(opts: { journeyId: string; groupType: string; detail: string }) {
    super(
      `Journey "${opts.journeyId}" could not resolve a group scope for type ` +
        `"${opts.groupType}": ${opts.detail}`,
    );
    this.name = "GroupScopeUnresolvableError";
    this.journeyId = opts.journeyId;
    this.groupType = opts.groupType;
  }
}

/** The `group` option as authored: a bare type (auto-resolve the key) or an
 * explicit `{ type, key }` pin. */
export type GroupScopeOption = string | { type: string; key?: string };

/**
 * Look up the contact's LIVE memberships of `type` and return the sole group
 * key — throwing {@link GroupScopeUnresolvableError} on 0 or ≥2 rows (the
 * count is named in the ambiguous message, so no LIMIT).
 */
async function lookupSoleMembership(opts: {
  db: Database;
  journeyId: string;
  type: string;
  contactId: string | undefined;
}): Promise<string> {
  const { db, journeyId, type, contactId } = opts;
  if (!contactId) {
    throw new GroupScopeUnresolvableError({
      journeyId,
      groupType: type,
      detail:
        "no membership — no contact was resolvable for this enrollment, so " +
        "membership auto-resolution has nothing to look up",
    });
  }
  const rows = await db
    .select({ groupKey: groups.groupKey })
    .from(groupMemberships)
    .innerJoin(groups, eq(groupMemberships.groupId, groups.id))
    .where(
      and(
        eq(groupMemberships.contactId, contactId),
        eq(groups.groupType, type),
        isNull(groups.deletedAt),
      ),
    );
  const sole = rows[0];
  if (rows.length === 1 && sole) {
    return sole.groupKey;
  }
  if (rows.length === 0) {
    throw new GroupScopeUnresolvableError({
      journeyId,
      groupType: type,
      detail: `no membership — the contact belongs to no live "${type}" group`,
    });
  }
  throw new GroupScopeUnresolvableError({
    journeyId,
    groupType: type,
    detail: `ambiguous: ${rows.length} memberships of type "${type}"`,
  });
}

/**
 * Resolve a `group` option to a concrete replay-stable `{ type, key }` scope.
 * Resolution order (DECISIONS §3.3) — EXACTLY this sequence:
 *
 * 1. **Explicit key** (`{ type, key }`): returned verbatim, NEVER recorded —
 *    it wins even over a recorded `__groupKeys__[type]`, and two same-type
 *    call sites with different explicit keys stay independent.
 * 2. **Trigger association** (`triggerGroups[type]`): returned, NOT recorded —
 *    it rides the task input, so it is replay-stable by construction.
 * 3. **Recorded** `journey_states.context.__groupKeys__[type]`: returned
 *    verbatim (only ever holds membership-resolved keys).
 * 4. **Sole live membership**: exactly one live membership of `type` → its
 *    key, RECORDED under `__groupKeys__[type]` via `recordOnce` (read-back
 *    semantics converge concurrent racers — the committed value is returned,
 *    never the locally computed one). 0 or ≥2 rows → throw
 *    {@link GroupScopeUnresolvableError}.
 *
 * `record: false` (future ctx.history use) keeps the order identical but step
 * 4 resolves WITHOUT writing.
 */
export async function resolveGroupScope(opts: {
  db: Database;
  stateId: string;
  journeyId: string;
  contactId: string | undefined;
  triggerGroups: Record<string, string> | undefined;
  option: GroupScopeOption;
  record?: boolean;
}): Promise<{ type: string; key: string }> {
  const { db, stateId, journeyId, contactId, triggerGroups, option } = opts;
  const record = opts.record ?? true;
  const type = typeof option === "string" ? option : option.type;

  // 1. Explicit key — verbatim, never recorded.
  if (typeof option === "object" && option.key !== undefined) {
    return { type, key: option.key };
  }

  // 2. Trigger association — replay-stable via the task input, not recorded.
  const triggered = triggerGroups?.[type];
  if (triggered !== undefined) {
    return { type, key: triggered };
  }

  if (record) {
    // 3+4. recordOnce's read-first IS step 3 (a recorded key returns without
    // computing); its compute IS step 4 (the membership lookup, throwing when
    // unresolvable — nothing is written on a throw). The returned value is
    // the committed read-back, so concurrent racers converge.
    const key = await recordOnce({
      db,
      stateId,
      namespace: "__groupKeys__",
      key: type,
      compute: () => lookupSoleMembership({ db, journeyId, type, contactId }),
    });
    return { type, key };
  }

  // record: false — same order, no write. 3: read the recorded bag directly.
  const recorded = await readRecordedValue({
    db,
    stateId,
    namespace: "__groupKeys__",
    key: type,
  });
  if (recorded !== undefined) {
    return { type, key: recorded as string };
  }
  // 4 without the record.
  const key = await lookupSoleMembership({ db, journeyId, type, contactId });
  return { type, key };
}
