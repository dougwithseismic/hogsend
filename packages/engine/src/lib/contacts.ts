import {
  bucketMemberships,
  contactAliases,
  contacts,
  type Database,
  emailPreferences,
  emailSends,
  journeyStates,
  userEvents,
} from "@hogsend/db";
import { and, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The transaction handle drizzle hands to a `db.transaction(cb)` callback. It
 * exposes the same `.select/.insert/.update/.execute/.query` surface as the
 * top-level `Database`, so the merge helpers below accept it interchangeably.
 */
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

type ContactRow = typeof contacts.$inferSelect;

export function contactWhereClause(id: string) {
  return UUID_REGEX.test(id)
    ? eq(contacts.id, id)
    : eq(contacts.externalId, id);
}

export async function resolveContact(opts: { db: Database; id: string }) {
  const { db, id } = opts;
  const rows = await db
    .select()
    .from(contacts)
    .where(and(contactWhereClause(id), isNull(contacts.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export function serializePrefs(row: typeof emailPreferences.$inferSelect) {
  return {
    id: row.id,
    userId: row.userId,
    email: row.email,
    unsubscribedAll: row.unsubscribedAll,
    suppressed: row.suppressed,
    bounceCount: row.bounceCount,
    categories: (row.categories ?? {}) as Record<string, boolean>,
    suppressedAt: row.suppressedAt?.toISOString() ?? null,
    lastBounceAt: row.lastBounceAt?.toISOString() ?? null,
  };
}

export function contactSearchFilter(search: string) {
  return or(
    ilike(contacts.email, `%${search}%`),
    ilike(contacts.externalId, `%${search}%`),
    ilike(contacts.anonymousId, `%${search}%`),
  );
}

/**
 * Normalized, sendable email: `trim` + `toLowerCase`. No dot/+tag stripping —
 * we store the NORMALIZED RAW email (D1), so the address must still deliver.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Identity resolution
// ---------------------------------------------------------------------------

type Kind = "external" | "email" | "anonymous";

interface ResolveKey {
  kind: Kind;
  value: string;
}

/**
 * Look up the single live contact owning `(kind, value)`, falling back to
 * `contact_aliases` on a miss so a stale (loser/promoted) key still resolves to
 * the SURVIVOR (risk 5). Returns the contact row or null.
 */
async function findByKey(tx: Tx, key: ResolveKey): Promise<ContactRow | null> {
  const column =
    key.kind === "external"
      ? contacts.externalId
      : key.kind === "email"
        ? contacts.email
        : contacts.anonymousId;

  const direct = await tx
    .select()
    .from(contacts)
    .where(and(eq(column, key.value), isNull(contacts.deletedAt)))
    .limit(1);
  if (direct[0]) return direct[0];

  // Alias fallback: the key may sit on a soft-deleted loser row.
  const alias = await tx
    .select({ contactId: contactAliases.contactId })
    .from(contactAliases)
    .where(
      and(
        eq(contactAliases.aliasKind, key.kind),
        eq(contactAliases.aliasValue, key.value),
      ),
    )
    .limit(1);
  if (!alias[0]) return null;

  const aliased = await tx
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, alias[0].contactId), isNull(contacts.deletedAt)))
    .limit(1);
  return aliased[0] ?? null;
}

/**
 * Merge `patch` onto the existing jsonb properties: `COALESCE(existing,'{}') ||
 * patch` (the patch wins on key conflict; an explicit `null` value in the patch
 * sets that key to JSON null, it does not delete it — matching the prior
 * upsert's `||` semantics). Returns the SQL fragment for the `properties` set.
 */
function mergePropertiesSql(patch: Record<string, unknown>) {
  return sql`COALESCE(${contacts.properties}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;
}

/** SURVIVOR RULE: identified (has external_id) > anonymous; then OLDEST
 * firstSeenAt; final tie-break lowest id. */
function pickSurvivor(rows: ContactRow[]): {
  survivor: ContactRow;
  losers: ContactRow[];
} {
  const sorted = [...rows].sort((a, b) => {
    const aIdent = a.externalId ? 0 : 1;
    const bIdent = b.externalId ? 0 : 1;
    if (aIdent !== bIdent) return aIdent - bIdent;
    const aSeen = a.firstSeenAt.getTime();
    const bSeen = b.firstSeenAt.getTime();
    if (aSeen !== bSeen) return aSeen - bSeen;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const [survivor, ...losers] = sorted;
  if (!survivor) {
    // Unreachable: callers only invoke this with >= 2 candidates.
    throw new Error("pickSurvivor called with no candidates");
  }
  return { survivor, losers };
}

/** The canonical text user_id key for a contact: external_id ?? anonymous_id ??
 * id. This is what the 5 contact-referencing tables join on (risk 1). */
function contactKey(row: ContactRow): string {
  return row.externalId ?? row.anonymousId ?? row.id;
}

/**
 * THE resolver (D1). Transactional. Resolves any combination of identity keys
 * (external_id / email / anonymous_id, in any subset — incl. anon-only or
 * email-only) to a single canonical `contacts` row, handling three cases:
 *
 *   - create        — no existing row owns any provided key.
 *   - fill-in-link  — exactly one row matches; missing keys are filled and a
 *                     `'promote'` alias is recorded for each newly-attached key.
 *   - collide-MERGE — 2-3 distinct rows match; a survivor is chosen (SURVIVOR
 *                     RULE) and the losers are re-pointed across all 5 tables,
 *                     folded, soft-deleted, and aliased (9-step order).
 *
 * INSERT RACE strategy: a `pg_advisory_xact_lock(hashtext(kind||value))` is taken
 * per provided key at the TOP of the tx (before any SELECT). Two concurrent
 * resolves for the same key serialize on the lock, so the second sees the first's
 * insert and links/merges instead of racing a duplicate row. The lock is held
 * until the tx commits/rolls back (xact-scoped) — no manual unlock.
 */
export async function resolveOrCreateContact(opts: {
  db: Database;
  userId?: string;
  email?: string;
  anonymousId?: string;
  contactProperties?: Record<string, unknown>;
}): Promise<{
  id: string;
  created: boolean;
  linked: boolean;
  merged: boolean;
}> {
  const { db, contactProperties } = opts;
  const userId = opts.userId?.trim() || undefined;
  const email = opts.email ? normalizeEmail(opts.email) : undefined;
  const anonymousId = opts.anonymousId?.trim() || undefined;

  const keys: ResolveKey[] = [];
  if (userId) keys.push({ kind: "external", value: userId });
  if (email) keys.push({ kind: "email", value: email });
  if (anonymousId) keys.push({ kind: "anonymous", value: anonymousId });

  if (keys.length === 0) {
    throw new Error(
      "resolveOrCreateContact requires at least one of userId, email, anonymousId",
    );
  }

  const patch = contactProperties ?? {};
  const hasPatch = Object.keys(patch).length > 0;

  return db.transaction(async (tx) => {
    // (0) Advisory locks per key — serialize concurrent resolves on the same
    // identity so the INSERT race can't mint duplicates. Sorted to keep a stable
    // acquisition order across callers (deadlock-safe).
    const lockArgs = keys
      .map((k) => `${k.kind}:${k.value}`)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const arg of lockArgs) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${arg}))`);
    }

    // (1) Resolve every provided key to its owning live contact (alias-aware).
    const matched = await Promise.all(keys.map((k) => findByKey(tx, k)));

    const distinct = new Map<string, ContactRow>();
    for (const row of matched) {
      if (row) distinct.set(row.id, row);
    }
    const candidates = [...distinct.values()];

    // --- CASE: create (no existing row) ---
    if (candidates.length === 0) {
      const inserted = await tx
        .insert(contacts)
        .values({
          externalId: userId ?? null,
          email: email ?? null,
          anonymousId: anonymousId ?? null,
          properties: patch,
        })
        .returning();
      const createdRow = inserted[0];
      if (!createdRow) throw new Error("Contact insert returned no row");
      return {
        id: createdRow.id,
        created: true,
        linked: false,
        merged: false,
      };
    }

    // --- CASE: fill-in-link (single existing row) ---
    const single = candidates[0];
    if (candidates.length === 1 && single) {
      const id = await fillInLink(tx, single, {
        userId,
        email,
        anonymousId,
        patch,
        hasPatch,
      });
      return { id, created: false, linked: true, merged: false };
    }

    // --- CASE: collide-MERGE (2-3 distinct rows) ---
    const id = await mergeContacts(tx, candidates, {
      userId,
      email,
      anonymousId,
      patch,
      hasPatch,
    });
    return { id, created: false, linked: true, merged: true };
  });
}

interface ResolveCtx {
  userId?: string;
  email?: string;
  anonymousId?: string;
  patch: Record<string, unknown>;
  hasPatch: boolean;
}

/**
 * Single matching row: fill any identity keys it is missing, record a `'promote'`
 * alias for each newly-attached key (provenance + belt-and-suspenders so the key
 * still resolves through the alias path), and apply the property patch.
 */
async function fillInLink(
  tx: Tx,
  row: ContactRow,
  ctx: ResolveCtx,
): Promise<string> {
  const set: Record<string, unknown> = {
    lastSeenAt: new Date(),
    updatedAt: new Date(),
  };
  const promoted: ResolveKey[] = [];

  if (ctx.userId && !row.externalId) {
    set.externalId = ctx.userId;
    promoted.push({ kind: "external", value: ctx.userId });
  }
  if (ctx.email && !row.email) {
    set.email = ctx.email;
    promoted.push({ kind: "email", value: ctx.email });
  }
  if (ctx.anonymousId && !row.anonymousId) {
    set.anonymousId = ctx.anonymousId;
    promoted.push({ kind: "anonymous", value: ctx.anonymousId });
  }
  if (ctx.hasPatch) {
    set.properties = mergePropertiesSql(ctx.patch);
  }

  await tx.update(contacts).set(set).where(eq(contacts.id, row.id));

  for (const key of promoted) {
    await tx
      .insert(contactAliases)
      .values({
        contactId: row.id,
        aliasKind: key.kind,
        aliasValue: key.value,
        fromContactId: null,
        reason: "promote",
      })
      .onConflictDoNothing({
        target: [contactAliases.aliasKind, contactAliases.aliasValue],
      });
  }

  return row.id;
}

/**
 * 2-3 distinct rows collide. Pick the survivor (SURVIVOR RULE) and execute the
 * LOCKED 9-step re-point order, ALL in this one tx. Returns survivor id.
 */
async function mergeContacts(
  tx: Tx,
  candidates: ContactRow[],
  ctx: ResolveCtx,
): Promise<string> {
  const { survivor, losers } = pickSurvivor(candidates);
  const survivorKey = contactKey(survivor);

  for (const loser of losers) {
    const loserStrKeys = [loser.externalId, loser.anonymousId, loser.id].filter(
      (k): k is string => Boolean(k),
    );
    // The id is the last-resort key for a loser that has neither external nor
    // anonymous id (its user_id rows were keyed on contacts.id).
    const loserKeysToRewrite = loserStrKeys;

    // (ii) user_events.user_id rewrite.
    await tx
      .update(userEvents)
      .set({ userId: survivorKey })
      .where(inArray(userEvents.userId, loserKeysToRewrite));

    // (iii) journey_states — exit the loser's duplicate active/waiting row when
    // the survivor already holds an active/waiting row in the same journey
    // (respect uq_user_journey_active), THEN rewrite user_id/user_email.
    await foldJourneyStates(tx, survivorKey, loserKeysToRewrite, survivor);

    // (iv) email_sends rewrite user_id + userEmail to survivor's.
    await tx
      .update(emailSends)
      .set({
        userId: survivorKey,
        ...(survivor.email ? { userEmail: survivor.email } : {}),
      })
      .where(inArray(emailSends.userId, loserKeysToRewrite));

    // (v) bucket_memberships — soft-leave the loser's duplicate active
    // membership when the survivor already holds one in the same bucket (respect
    // uq_user_bucket_active, preserve survivor's dwell clock), THEN rewrite.
    await foldBucketMemberships(tx, survivorKey, loserKeysToRewrite);

    // (vi) email_preferences FOLD (never blind-rewrite — risk 6).
    await foldEmailPreferences(tx, loser, survivorKey);

    // (ix) RECORD aliases for each loser key → survivor.
    await recordMergeAliases(tx, survivor.id, loser);
  }

  // (vii) FOLD properties: survivor wins over losers; then the call's patch wins
  // last. timezone = survivor ?? loser; firstSeenAt = least.
  let foldedProps: Record<string, unknown> = {};
  for (const loser of losers) {
    foldedProps = { ...foldedProps, ...((loser.properties ?? {}) as object) };
  }
  foldedProps = { ...foldedProps, ...((survivor.properties ?? {}) as object) };
  if (ctx.hasPatch) {
    foldedProps = { ...foldedProps, ...ctx.patch };
  }

  const survivorTimezone =
    survivor.timezone ?? losers.find((l) => l.timezone)?.timezone ?? null;
  const earliestFirstSeen = [survivor, ...losers].reduce(
    (min, r) => (r.firstSeenAt < min ? r.firstSeenAt : min),
    survivor.firstSeenAt,
  );

  // Fill any identity keys the survivor is missing but a loser owned / the call
  // supplied, so the merged row carries the full identity.
  const survivorSet: Record<string, unknown> = {
    properties: foldedProps,
    timezone: survivorTimezone,
    firstSeenAt: earliestFirstSeen,
    lastSeenAt: new Date(),
    updatedAt: new Date(),
  };
  if (!survivor.externalId) {
    const fromLoser = losers.find((l) => l.externalId)?.externalId;
    const next = ctx.userId ?? fromLoser;
    if (next) survivorSet.externalId = next;
  }
  if (!survivor.email) {
    const fromLoser = losers.find((l) => l.email)?.email;
    const next = ctx.email ?? fromLoser;
    if (next) survivorSet.email = next;
  }
  if (!survivor.anonymousId) {
    const fromLoser = losers.find((l) => l.anonymousId)?.anonymousId;
    const next = ctx.anonymousId ?? fromLoser;
    if (next) survivorSet.anonymousId = next;
  }

  // (viii) Soft-delete the losers FIRST — frees their external_id/email/
  // anonymous_id from the partial-unique indexes (WHERE deleted_at IS NULL) —
  // THEN copy keys onto the survivor. Reverse order self-collides (risk 4).
  await tx
    .update(contacts)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      inArray(
        contacts.id,
        losers.map((l) => l.id),
      ),
    );

  await tx
    .update(contacts)
    .set(survivorSet)
    .where(eq(contacts.id, survivor.id));

  return survivor.id;
}

/**
 * journey_states fold: if the survivor already holds an active/waiting row in a
 * journey where a loser key also holds one, EXIT the loser's row first (the
 * partial-unique uq_user_journey_active forbids two active rows for the same
 * (user_id, journey, status)), then rewrite the remaining loser rows onto the
 * survivor key + survivor email.
 */
async function foldJourneyStates(
  tx: Tx,
  survivorKey: string,
  loserKeys: string[],
  survivor: ContactRow,
): Promise<void> {
  const ACTIVE = ["active", "waiting"] as const;

  const survivorActive = await tx
    .select({
      journeyId: journeyStates.journeyId,
      status: journeyStates.status,
    })
    .from(journeyStates)
    .where(
      and(
        eq(journeyStates.userId, survivorKey),
        inArray(journeyStates.status, [...ACTIVE]),
        isNull(journeyStates.deletedAt),
      ),
    );

  // (journeyId|status) pairs the survivor already occupies — a loser row sharing
  // one would violate uq_user_journey_active on rewrite.
  const occupied = new Set(
    survivorActive.map((s) => `${s.journeyId}|${s.status}`),
  );

  const loserActive = await tx
    .select({
      id: journeyStates.id,
      journeyId: journeyStates.journeyId,
      status: journeyStates.status,
    })
    .from(journeyStates)
    .where(
      and(
        inArray(journeyStates.userId, loserKeys),
        inArray(journeyStates.status, [...ACTIVE]),
        isNull(journeyStates.deletedAt),
      ),
    );

  const idsToExit = loserActive
    .filter((l) => occupied.has(`${l.journeyId}|${l.status}`))
    .map((l) => l.id);

  if (idsToExit.length > 0) {
    await tx
      .update(journeyStates)
      .set({ status: "exited", exitedAt: new Date(), updatedAt: new Date() })
      .where(inArray(journeyStates.id, idsToExit));
  }

  // Rewrite the rest (non-conflicting active rows + all terminal rows) onto the
  // survivor key. The just-exited rows are now 'exited' (terminal, re-entrant)
  // so they no longer collide on the active-partial index.
  await tx
    .update(journeyStates)
    .set({
      userId: survivorKey,
      ...(survivor.email ? { userEmail: survivor.email } : {}),
      updatedAt: new Date(),
    })
    .where(inArray(journeyStates.userId, loserKeys));
}

/**
 * bucket_memberships fold: if the survivor already holds an ACTIVE membership in
 * a bucket where a loser key also holds one, soft-LEAVE the loser's row first
 * (uq_user_bucket_active forbids two active rows for the same (user, bucket);
 * preserve the survivor's dwell clock), then rewrite the rest onto the survivor.
 */
async function foldBucketMemberships(
  tx: Tx,
  survivorKey: string,
  loserKeys: string[],
): Promise<void> {
  const survivorActive = await tx
    .select({ bucketId: bucketMemberships.bucketId })
    .from(bucketMemberships)
    .where(
      and(
        eq(bucketMemberships.userId, survivorKey),
        eq(bucketMemberships.status, "active"),
        isNull(bucketMemberships.deletedAt),
      ),
    );
  const occupied = new Set(survivorActive.map((s) => s.bucketId));

  const loserActive = await tx
    .select({
      id: bucketMemberships.id,
      bucketId: bucketMemberships.bucketId,
    })
    .from(bucketMemberships)
    .where(
      and(
        inArray(bucketMemberships.userId, loserKeys),
        eq(bucketMemberships.status, "active"),
        isNull(bucketMemberships.deletedAt),
      ),
    );

  const idsToLeave = loserActive
    .filter((l) => occupied.has(l.bucketId))
    .map((l) => l.id);

  if (idsToLeave.length > 0) {
    await tx
      .update(bucketMemberships)
      .set({ status: "left", leftAt: new Date(), updatedAt: new Date() })
      .where(inArray(bucketMemberships.id, idsToLeave));
  }

  await tx
    .update(bucketMemberships)
    .set({ userId: survivorKey, updatedAt: new Date() })
    .where(inArray(bucketMemberships.userId, loserKeys));
}

/**
 * email_preferences FOLD (risk 6 — suppression/unsubscribe must NEVER be lost).
 * For each of the loser's pref rows, fold it into whatever currently sits at
 * `(survivorKey, email)`:
 *   unsubscribedAll = OR, suppressed = OR, bounceCount = MAX,
 *   categories = merge with FALSE winning on conflict (unsub never lost),
 *   suppressedAt / lastBounceAt = earliest non-null.
 * The TARGET row is re-read fresh per loser pref (NOT a cached map), so a
 * 3-way merge where two losers each carry a pref for the SAME email folds
 * loser2 into loser1's already-folded result instead of colliding on
 * `uq(user_id, email)` (risk 3). The loser row is deleted after folding.
 */
async function foldEmailPreferences(
  tx: Tx,
  loser: ContactRow,
  survivorKey: string,
): Promise<void> {
  const loserKeys = [loser.externalId, loser.anonymousId, loser.id].filter(
    (k): k is string => Boolean(k),
  );

  const loserPrefs = await tx
    .select()
    .from(emailPreferences)
    .where(inArray(emailPreferences.userId, loserKeys));

  if (loserPrefs.length === 0) return;

  const earliest = (a: Date | null, b: Date | null): Date | null => {
    if (!a) return b;
    if (!b) return a;
    return a < b ? a : b;
  };

  for (const lp of loserPrefs) {
    // Re-read the CURRENT target row for (survivorKey, lp.email) — it may be the
    // original survivor pref, a prior loser's just-folded pref, or absent.
    const targetRows = await tx
      .select()
      .from(emailPreferences)
      .where(
        and(
          eq(emailPreferences.userId, survivorKey),
          eq(emailPreferences.email, lp.email),
        ),
      )
      .limit(1);
    const target = targetRows[0];

    if (!target) {
      // The (survivorKey, lp.email) slot is free — re-point the loser row.
      await tx
        .update(emailPreferences)
        .set({ userId: survivorKey, updatedAt: new Date() })
        .where(eq(emailPreferences.id, lp.id));
      continue;
    }

    // FOLD into the target row, FALSE wins on category conflict.
    const foldedCategories: Record<string, boolean> = {
      ...((lp.categories ?? {}) as Record<string, boolean>),
      ...((target.categories ?? {}) as Record<string, boolean>),
    };
    for (const [k, lv] of Object.entries(
      (lp.categories ?? {}) as Record<string, boolean>,
    )) {
      const tv = target.categories?.[k];
      if (lv === false || tv === false) foldedCategories[k] = false;
    }

    await tx
      .update(emailPreferences)
      .set({
        unsubscribedAll: target.unsubscribedAll || lp.unsubscribedAll,
        suppressed: target.suppressed || lp.suppressed,
        bounceCount: Math.max(target.bounceCount, lp.bounceCount),
        categories: foldedCategories,
        suppressedAt: earliest(target.suppressedAt, lp.suppressedAt),
        lastBounceAt: earliest(target.lastBounceAt, lp.lastBounceAt),
        updatedAt: new Date(),
      })
      .where(eq(emailPreferences.id, target.id));

    // The loser row would collide with the target on (survivorKey, email) if
    // re-pointed — its data is folded in, so drop it.
    await tx.delete(emailPreferences).where(eq(emailPreferences.id, lp.id));
  }
}

/** RECORD a contact_aliases row per loser key → survivor (reason 'merge'). */
async function recordMergeAliases(
  tx: Tx,
  survivorId: string,
  loser: ContactRow,
): Promise<void> {
  const aliasRows: {
    contactId: string;
    aliasKind: Kind;
    aliasValue: string;
    fromContactId: string;
    reason: string;
  }[] = [];
  if (loser.externalId) {
    aliasRows.push({
      contactId: survivorId,
      aliasKind: "external",
      aliasValue: loser.externalId,
      fromContactId: loser.id,
      reason: "merge",
    });
  }
  if (loser.email) {
    aliasRows.push({
      contactId: survivorId,
      aliasKind: "email",
      aliasValue: loser.email,
      fromContactId: loser.id,
      reason: "merge",
    });
  }
  if (loser.anonymousId) {
    aliasRows.push({
      contactId: survivorId,
      aliasKind: "anonymous",
      aliasValue: loser.anonymousId,
      fromContactId: loser.id,
      reason: "merge",
    });
  }

  if (aliasRows.length === 0) return;

  // On conflict (a stale key already aliases somewhere), re-point it to this
  // survivor — the most recent merge wins.
  await tx
    .insert(contactAliases)
    .values(aliasRows)
    .onConflictDoUpdate({
      target: [contactAliases.aliasKind, contactAliases.aliasValue],
      set: {
        contactId: survivorId,
        fromContactId: loser.id,
        reason: "merge",
        updatedAt: new Date(),
      },
    });
}

// ---------------------------------------------------------------------------
// Retained wrapper + public-route helpers
// ---------------------------------------------------------------------------

/**
 * Retained thin wrapper so existing callers (`ingestion.ts`,
 * `import-contacts.ts`) keep compiling. `externalId` is now OPTIONAL and its
 * `properties` are forwarded as `contactProperties`. Delegates to the real
 * `resolveOrCreateContact` (the old `onConflictDoUpdate(target: externalId)`
 * upsert couldn't create email-only/anon contacts or merge — decision #9 / §5).
 */
export async function upsertContact(opts: {
  db: Database;
  externalId?: string;
  email?: string;
  anonymousId?: string;
  properties?: Record<string, unknown>;
}): Promise<{
  id: string;
  created: boolean;
  linked: boolean;
  merged: boolean;
}> {
  return resolveOrCreateContact({
    db: opts.db,
    userId: opts.externalId,
    email: opts.email,
    anonymousId: opts.anonymousId,
    contactProperties: opts.properties,
  });
}

/**
 * Find non-deleted contacts by email or external id. Used by the public
 * `/v1/contacts/find` route. Email is normalized before lookup.
 */
export async function findContacts(opts: {
  db: Database;
  email?: string;
  userId?: string;
}): Promise<ContactRow[]> {
  const { db } = opts;
  const email = opts.email ? normalizeEmail(opts.email) : undefined;
  const userId = opts.userId?.trim() || undefined;

  const clauses = [];
  if (email) clauses.push(eq(contacts.email, email));
  if (userId) clauses.push(eq(contacts.externalId, userId));
  if (clauses.length === 0) return [];

  return db
    .select()
    .from(contacts)
    .where(and(or(...clauses), isNull(contacts.deletedAt)));
}

/**
 * Soft-delete a contact resolved by email or external id (sets `deletedAt`).
 * Returns true iff a live row was found and soft-deleted.
 */
export async function softDeleteContact(opts: {
  db: Database;
  email?: string;
  userId?: string;
}): Promise<boolean> {
  const { db } = opts;
  const email = opts.email ? normalizeEmail(opts.email) : undefined;
  const userId = opts.userId?.trim() || undefined;

  const clauses = [];
  if (email) clauses.push(eq(contacts.email, email));
  if (userId) clauses.push(eq(contacts.externalId, userId));
  if (clauses.length === 0) return false;

  const updated = await db
    .update(contacts)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(or(...clauses), isNull(contacts.deletedAt)))
    .returning({ id: contacts.id });

  return updated.length > 0;
}

/**
 * Resolve a sendable recipient for `/v1/emails` and `applyListMembership`.
 * Returns the contact's normalized email plus the identity needed to denormalize
 * a send row / key an `email_preferences` write. Returns null when no resolvable
 * email exists (the caller maps that to a 404/400).
 *
 * Lookup precedence: a normalized `email` arg short-circuits; otherwise resolve
 * the contact by `userId` (external id, alias-aware) and read back its email.
 * `externalId` is the contact's external id (may be null for an email-only
 * contact); `contactId` is the uuid fallback for the `email_preferences.user_id`
 * column (risk 10) when externalId is null.
 */
export async function resolveRecipient(opts: {
  db: Database;
  userId?: string;
  email?: string;
}): Promise<{
  email: string;
  externalId: string | null;
  contactId: string;
} | null> {
  const { db } = opts;
  const email = opts.email ? normalizeEmail(opts.email) : undefined;
  const userId = opts.userId?.trim() || undefined;

  // Resolve the owning contact, preferring email then userId. Use a direct +
  // alias-aware lookup so a stale (merged) key still resolves.
  let row: ContactRow | null = null;

  if (email) {
    const byEmail = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.email, email), isNull(contacts.deletedAt)))
      .limit(1);
    row = byEmail[0] ?? null;
    if (!row) {
      const aliased = await resolveViaAlias(db, "email", email);
      row = aliased;
    }
    // Email arg is authoritative as the send target even if no contact row
    // exists yet — return it so a brand-new address can still be emailed.
    if (!row) {
      return { email, externalId: null, contactId: email };
    }
  } else if (userId) {
    const byExternal = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.externalId, userId), isNull(contacts.deletedAt)))
      .limit(1);
    row = byExternal[0] ?? null;
    if (!row) {
      row = await resolveViaAlias(db, "external", userId);
    }
    if (!row?.email) return null;
  } else {
    return null;
  }

  if (!row?.email) {
    // Email path with a matched row that has no email is impossible (matched on
    // email), so this only guards the userId path's missing-email case.
    return null;
  }

  return {
    email: row.email,
    externalId: row.externalId,
    contactId: row.id,
  };
}

/** Alias-aware lookup helper for resolveRecipient (mirrors findByKey but on the
 * top-level db handle, no tx). */
async function resolveViaAlias(
  db: Database,
  kind: Kind,
  value: string,
): Promise<ContactRow | null> {
  const alias = await db
    .select({ contactId: contactAliases.contactId })
    .from(contactAliases)
    .where(
      and(
        eq(contactAliases.aliasKind, kind),
        eq(contactAliases.aliasValue, value),
      ),
    )
    .limit(1);
  if (!alias[0]) return null;

  const rows = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, alias[0].contactId), isNull(contacts.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}
