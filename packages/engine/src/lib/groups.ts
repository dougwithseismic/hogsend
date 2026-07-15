import type { AnalyticsProvider, Group, GroupMembership } from "@hogsend/core";
import { contacts, type Database, groupMemberships, groups } from "@hogsend/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getAnalytics } from "./analytics-singleton.js";
import type { Logger } from "./logger.js";

/**
 * Sovereign, DB-first group helpers — Hogsend's standalone answer to PostHog
 * group analytics. Every function is single-object-in / result-object-out with
 * `db` injected, mirroring the house style in {@link file://./contacts.ts}.
 *
 * A group is identified by its `(groupType, groupKey)` natural key. The `groups`
 * unique index is PARTIAL (`WHERE deleted_at IS NULL`), so every upsert MUST
 * name that predicate as the conflict arbiter — see {@link identifyGroup}.
 */

/**
 * Thrown by {@link addGroupMember} when the target contact does not exist (or is
 * soft-deleted). Signalled BEFORE the group is resolve-or-created, so a bad
 * contact id never mints an orphan group; the route catches it → 404. Mirrors
 * the typed-error pattern in {@link file://./contacts.ts}
 * (`PublishableAnonymousMergeError`).
 */
export class GroupContactNotFoundError extends Error {
  constructor(public readonly contactId: string) {
    super(`Contact not found: ${contactId}`);
    this.name = "GroupContactNotFoundError";
  }
}

/** Rows returned by drizzle's select match the portable `Group` shape 1:1. */
type GroupRow = typeof groups.$inferSelect;

/** Clamp a caller-supplied page size to a sane default + hard cap. */
function clampLimit(
  limit: number | undefined,
  fallback = 50,
  cap = 200,
): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(limit), cap);
}

/** Non-negative page offset. */
function clampOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset) || offset <= 0) return 0;
  return Math.floor(offset);
}

/**
 * Identify (upsert) a group by its `(groupType, groupKey)` natural key and,
 * best-effort, mirror the property WRITE to the active analytics provider
 * (PostHog `groupIdentify`).
 *
 * CRITICAL — the `groups_type_key_unique_idx` unique index is PARTIAL
 * (`WHERE deleted_at IS NULL`). For `onConflictDoUpdate` the arbiter predicate
 * matching that partial index goes in **`targetWhere`** (NOT `where`, which is
 * ambiguous and silently misbehaves → duplicate rows / 42P10). On conflict we
 * MERGE properties with the exact jsonb idiom `contacts.ts` uses
 * (`coalesce(existing,'{}'::jsonb) || <new>::jsonb`, new wins), COALESCE the
 * displayName (a caller who omits it never nulls an existing name), and bump
 * `lastSeenAt` + `updatedAt`; `firstSeenAt` is preserved.
 */
export async function identifyGroup(opts: {
  db: Database;
  groupType: string;
  groupKey: string;
  displayName?: string;
  properties?: Record<string, unknown>;
  organizationId?: string;
  analytics?: AnalyticsProvider;
  logger?: Logger;
}): Promise<{ group: Group }> {
  const { db, groupType, groupKey, displayName, properties, organizationId } =
    opts;
  const now = new Date();

  const updateSet: Record<string, unknown> = {
    lastSeenAt: now,
    updatedAt: now,
  };
  // Merge only when properties were supplied — an association-only upsert
  // (associateGroups / resolveGroupId) must not rewrite the property bag.
  if (properties) {
    updateSet.properties = sql`coalesce(${groups.properties}, '{}'::jsonb) || ${JSON.stringify(properties)}::jsonb`;
  }
  // COALESCE displayName: only set when the caller supplied one, so an omitted
  // name never clobbers an existing one.
  if (displayName !== undefined) {
    updateSet.displayName = displayName;
  }

  const inserted = await db
    .insert(groups)
    .values({
      groupType,
      groupKey,
      displayName: displayName ?? null,
      properties: properties ?? {},
      organizationId: organizationId ?? null,
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: [groups.groupType, groups.groupKey],
      targetWhere: sql`${groups.deletedAt} is null`,
      set: updateSet,
    })
    .returning();

  const row = inserted[0];
  if (!row) throw new Error("Group upsert returned no row");

  // Best-effort analytics group-property WRITE (the PostHog groupIdentify path).
  // Association-only upserts pass no properties, so this stays a no-op there.
  const analytics = opts.analytics ?? getAnalytics();
  if (properties && analytics?.capabilities.groups && analytics.groupIdentify) {
    try {
      analytics.groupIdentify({ groupType, groupKey, properties });
    } catch (err) {
      opts.logger?.debug("groupIdentify failed (non-fatal)", {
        err,
        groupType,
        groupKey,
      });
    }
  }

  return { group: row };
}

/**
 * Resolve-or-create the LIVE group for `(groupType, groupKey)` WITHOUT touching
 * its property bag or firing analytics (association context only). Reuses
 * {@link identifyGroup}'s atomic partial-index upsert — passing no `properties`
 * skips the merge AND the groupIdentify wire — so the select-then-insert race
 * the campaigns route guards against never arises (the upsert is one statement).
 */
async function resolveGroupId(
  db: Database,
  groupType: string,
  groupKey: string,
): Promise<string> {
  const { group } = await identifyGroup({ db, groupType, groupKey });
  return group.id;
}

/**
 * INGEST helper (Phase 2.2): associate a contact with each group in a
 * `groupType → groupKey` map. Ensures every group row exists (association only,
 * NO property write, NO analytics) then upserts a `group_memberships` row per
 * group via `onConflictDoNothing` (its unique index is NOT partial, so no
 * arbiter predicate is needed). No-ops cleanly on an empty map. Returns the
 * number of groups whose membership is now in place.
 */
export async function associateGroups(opts: {
  db: Database;
  contactId: string;
  groups: Record<string, string>;
}): Promise<{ associated: number }> {
  const { db, contactId } = opts;
  const entries = Object.entries(opts.groups ?? {});
  if (entries.length === 0) return { associated: 0 };

  let associated = 0;
  for (const [groupType, groupKey] of entries) {
    if (!groupType || !groupKey) continue;
    const groupId = await resolveGroupId(db, groupType, groupKey);
    await db
      .insert(groupMemberships)
      .values({ groupId, contactId })
      .onConflictDoNothing({
        target: [groupMemberships.groupId, groupMemberships.contactId],
      });
    associated += 1;
  }
  return { associated };
}

/**
 * Add a contact to a group. FIRST assert the contact exists (else the FK-bound
 * membership insert would 23503 AFTER the group was resolve-or-created, minting
 * an orphan group and 500-ing) — a missing/soft-deleted contact throws
 * {@link GroupContactNotFoundError} BEFORE any group is touched. Then
 * resolve-or-create the live group (association only) and INSERT the membership
 * via `onConflictDoNothing`; when nothing is returned the contact is already a
 * member, so we read the existing row. `created` reflects whether THIS call
 * inserted the membership.
 */
export async function addGroupMember(opts: {
  db: Database;
  groupType: string;
  groupKey: string;
  contactId: string;
  role?: string;
}): Promise<{ membership: GroupMembership; created: boolean }> {
  const { db, groupType, groupKey, contactId, role } = opts;

  // Contact-existence guard — BEFORE `resolveGroupId` so a bad id never creates
  // an orphan group. The route validated `contactId` is a well-formed uuid, so
  // this select cannot 22P02. Only live (non-deleted) contacts qualify.
  const contactRows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), isNull(contacts.deletedAt)))
    .limit(1);
  if (!contactRows[0]) {
    throw new GroupContactNotFoundError(contactId);
  }

  const groupId = await resolveGroupId(db, groupType, groupKey);

  const inserted = await db
    .insert(groupMemberships)
    .values({ groupId, contactId, role: role ?? null })
    .onConflictDoNothing({
      target: [groupMemberships.groupId, groupMemberships.contactId],
    })
    .returning();

  if (inserted[0]) {
    return { membership: inserted[0], created: true };
  }

  // Already a member — the conflict swallowed the insert; read the live row.
  const existing = await db
    .select()
    .from(groupMemberships)
    .where(
      and(
        eq(groupMemberships.groupId, groupId),
        eq(groupMemberships.contactId, contactId),
      ),
    )
    .limit(1);

  const row = existing[0];
  if (!row) throw new Error("Membership upsert returned no row");
  return { membership: row, created: false };
}

/**
 * Remove a contact from a group. Hard-deletes the membership row (memberships
 * have no soft-delete column). Resolves the LIVE group first; a missing group or
 * absent membership yields `{ removed: false }`.
 */
export async function removeGroupMember(opts: {
  db: Database;
  groupType: string;
  groupKey: string;
  contactId: string;
}): Promise<{ removed: boolean }> {
  const { db, groupType, groupKey, contactId } = opts;
  const { group } = await getGroup({ db, groupType, groupKey });
  if (!group) return { removed: false };

  const deleted = await db
    .delete(groupMemberships)
    .where(
      and(
        eq(groupMemberships.groupId, group.id),
        eq(groupMemberships.contactId, contactId),
      ),
    )
    .returning({ id: groupMemberships.id });

  return { removed: deleted.length > 0 };
}

/** Fetch the single LIVE group for `(groupType, groupKey)`, or null. */
export async function getGroup(opts: {
  db: Database;
  groupType: string;
  groupKey: string;
}): Promise<{ group: Group | null }> {
  const { db, groupType, groupKey } = opts;
  const rows = await db
    .select()
    .from(groups)
    .where(
      and(
        eq(groups.groupType, groupType),
        eq(groups.groupKey, groupKey),
        isNull(groups.deletedAt),
      ),
    )
    .limit(1);
  const row: GroupRow | undefined = rows[0];
  return { group: row ?? null };
}

/**
 * List LIVE groups, newest-seen first, with an optional `groupType` filter and
 * clamped pagination (default 50, hard cap 200).
 */
export async function listGroups(opts: {
  db: Database;
  groupType?: string;
  limit?: number;
  offset?: number;
}): Promise<{ groups: Group[] }> {
  const { db, groupType } = opts;
  const where = groupType
    ? and(eq(groups.groupType, groupType), isNull(groups.deletedAt))
    : isNull(groups.deletedAt);

  const rows = await db
    .select()
    .from(groups)
    .where(where)
    .orderBy(desc(groups.lastSeenAt))
    .limit(clampLimit(opts.limit))
    .offset(clampOffset(opts.offset));

  return { groups: rows };
}

/**
 * List the members of a LIVE group (joining `group_memberships → contacts`),
 * newest-joined first, with clamped pagination. Only live contacts are
 * surfaced. Returns `[]` when the group does not exist.
 */
export async function listGroupMembers(opts: {
  db: Database;
  groupType: string;
  groupKey: string;
  limit?: number;
  offset?: number;
}): Promise<{
  members: Array<{
    contactId: string;
    email: string | null;
    externalId: string | null;
    role: string | null;
    joinedAt: Date;
  }>;
}> {
  const { db, groupType, groupKey } = opts;
  const { group } = await getGroup({ db, groupType, groupKey });
  if (!group) return { members: [] };

  const members = await db
    .select({
      contactId: groupMemberships.contactId,
      email: contacts.email,
      externalId: contacts.externalId,
      role: groupMemberships.role,
      joinedAt: groupMemberships.joinedAt,
    })
    .from(groupMemberships)
    .innerJoin(contacts, eq(groupMemberships.contactId, contacts.id))
    .where(
      and(eq(groupMemberships.groupId, group.id), isNull(contacts.deletedAt)),
    )
    .orderBy(desc(groupMemberships.joinedAt))
    .limit(clampLimit(opts.limit))
    .offset(clampOffset(opts.offset));

  return { members };
}
