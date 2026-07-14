import {
  bucketMemberships,
  contactAliases,
  contacts,
  crmLinks,
  type Database,
  deals,
  emailPreferences,
  emailSends,
  groupMemberships,
  journeyStates,
  userEvents,
} from "@hogsend/db";
import { and, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Thrown by {@link resolveOrCreateContact} when a PUBLISHABLE (browser, pk_) anon
 * write would attach to / merge into / mutate a contact that already carries an
 * IDENTIFIED key (`external_id` or `email`), OR would drive a collide-MERGE.
 *
 * The `anonymousId` (PostHog `get_distinct_id()`) is browser-readable by design,
 * so on the publishable path it is NOT a secret and must never be a merge driver
 * or a path to a victim's identified contact. An anon-only publishable write may
 * only create or update its OWN anonymous-only contact. Handlers translate this
 * to a 403. The secret-key path NEVER sets `restrictToAnonymous`, so its behavior
 * is unchanged.
 */
export class PublishableAnonymousMergeError extends Error {
  constructor(
    message = "publishable anonymous write cannot attach to or merge an identified contact",
  ) {
    super(message);
    this.name = "PublishableAnonymousMergeError";
  }
}

/**
 * True when `value` is the canonical key of an IDENTIFIED contact — i.e. a
 * live contact's `external_id`, or its `email` when that is its canonical key
 * (no `external_id`). Such a value names an identified person, so a
 * token-less publishable/unauthenticated caller must NOT be allowed to claim
 * it as an "anon id" (the feed-read and arrival-stamp forgery guard).
 *
 * A genuine browser anon id only ever matches a contact via `anonymous_id`
 * whose canonical key is that same anon id (the contact has no `external_id`)
 * — that is the caller's OWN anon contact and is allowed (returns false).
 *
 * Lives here beside `PublishableAnonymousMergeError` because it is the same
 * invariant read-side: consumed by `resolveFeedRecipient` (feed reads) and
 * `POST /v1/t/arrive` (arrival stamps).
 */
export async function collidesWithIdentified(
  db: Database,
  value: string,
): Promise<boolean> {
  const rows = await db
    .select({
      externalId: contacts.externalId,
      email: contacts.email,
      anonymousId: contacts.anonymousId,
    })
    .from(contacts)
    .where(
      and(
        or(
          eq(contacts.externalId, value),
          eq(contacts.email, value),
          eq(contacts.anonymousId, value),
        ),
        isNull(contacts.deletedAt),
      ),
    );
  for (const row of rows) {
    // The supplied value is this contact's `external_id` → its rows are keyed
    // on it (identified). Reject.
    if (row.externalId === value) return true;
    // The supplied value is this contact's `email` AND that email is its
    // canonical key (no external_id) → identified rows are keyed on it. Reject.
    if (row.email === value && !row.externalId) return true;
  }
  return false;
}

/**
 * Thrown by {@link resolveOrCreateContact}'s engine-internal `contactId` pin when
 * the pinned subject row no longer exists and no merge-alias chain leads to a live
 * survivor (the subject was hard-deleted). The internal re-emit is then dropped
 * (ingestEvent returns `{ stored: false }`, logs `identity.provenance.lost`) rather
 * than value-resolving — a value fall-back could mint the very phantom twin the
 * pin exists to prevent. Reachable ONLY for a hard-deleted/unfollowable subject.
 */
export class ContactProvenanceLostError extends Error {
  constructor(public readonly contactId: string) {
    super(
      `contact provenance lost: no live contact or survivor for ${contactId}`,
    );
    this.name = "ContactProvenanceLostError";
  }
}

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

export interface SerializedContact {
  id: string;
  externalId: string | null;
  email: string | null;
  properties: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Serialize a contact row to its JSON shape (timestamps → ISO strings). The
 * PUBLIC `/v1/contacts` Contact shape (§2.5 / `@hogsend/client`) does NOT include
 * `anonymousId`; the admin surface does. `includeAnonymousId` toggles that single
 * field (and the return type) so both routes share one serializer without
 * diverging the public type.
 */
export function serializeContact(
  row: ContactRow,
  opts: { includeAnonymousId: true },
): SerializedContact & { anonymousId: string | null };
export function serializeContact(
  row: ContactRow,
  opts?: { includeAnonymousId?: false },
): SerializedContact;
export function serializeContact(
  row: ContactRow,
  opts?: { includeAnonymousId?: boolean },
): SerializedContact & { anonymousId?: string | null } {
  return {
    id: row.id,
    externalId: row.externalId,
    ...(opts?.includeAnonymousId ? { anonymousId: row.anonymousId } : {}),
    email: row.email,
    properties: (row.properties ?? {}) as Record<string, unknown>,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
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
    ilike(contacts.discordId, `%${search}%`),
  );
}

/**
 * Normalized, sendable email: `trim` + `toLowerCase`. No dot/+tag stripping —
 * we store the NORMALIZED RAW email (D1), so the address must still deliver.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** `normalizeEmail` for a maybe-missing address. */
export function normalizeEmailOrNull(
  email: string | null | undefined,
): string | null {
  return email ? normalizeEmail(email) : null;
}

// ---------------------------------------------------------------------------
// Identity resolution
// ---------------------------------------------------------------------------

type Kind = "external" | "email" | "anonymous" | "discord";

interface ResolveKey {
  kind: Kind;
  value: string;
}

/** Postgres uuid syntax — guards the `contacts.id` fallback cast below. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
        : key.kind === "anonymous"
          ? contacts.anonymousId
          : contacts.discordId;

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
  if (alias[0]) {
    const aliased = await tx
      .select()
      .from(contacts)
      .where(
        and(eq(contacts.id, alias[0].contactId), isNull(contacts.deletedAt)),
      )
      .limit(1);
    if (aliased[0]) return aliased[0];
  }

  // Row-id fallback (external keys only): an email-only / anonymous-only
  // contact's canonical key (`external_id ?? anonymous_id ?? id`) IS its row id,
  // and that key leaves the system — in Hatchet event payloads, outbound
  // destination `userId`s, and `hs_t` identity tokens. When such a key round-trips
  // back through ingest as a `userId` (e.g. a PostHog webhook forwarding events
  // for a person identified via the `hs_t` stitch), it must resolve to the SAME
  // contact, not mint a duplicate keyed by the old row's id.
  if (key.kind === "external" && UUID_PATTERN.test(key.value)) {
    const byId = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, key.value), isNull(contacts.deletedAt)))
      .limit(1);
    return byId[0] ?? null;
  }

  return null;
}

/**
 * ENGINE-INTERNAL provenance pin (see {@link resolveOrCreateContact}'s
 * `contactId`). Resolve to the EXACT subject row by its unforgeable uuid PK and
 * fold there — never value-probing, never minting. Serializes on the row PK via
 * `FOR UPDATE`, so a concurrent collide-MERGE that soft-deletes this row as a
 * loser blocks on / is observed by this pin (rather than racing the mismatched
 * `external:value` vs `anonymous:value` advisory locks). If the row was merged
 * away (soft-deleted), follow the server-authored merge-alias chain to the live
 * SURVIVOR by row id — independent of alias kind/value, closing the post-merge
 * anon-alias residual. A hard-deleted/unfollowable subject throws
 * {@link ContactProvenanceLostError} (the caller drops the event, never mints).
 */
async function resolveByContactId(
  tx: Tx,
  contactId: string,
  ctx: { patch: Record<string, unknown>; hasPatch: boolean },
): Promise<{
  id: string;
  resolvedKey: string;
  created: boolean;
  linked: boolean;
  merged: boolean;
}> {
  let row: ContactRow | null =
    (
      await tx
        .select()
        .from(contacts)
        .where(eq(contacts.id, contactId))
        .for("update")
        .limit(1)
    )[0] ?? null;
  if (!row || row.deletedAt) {
    row = await followToSurvivor(tx, contactId);
  }
  if (!row) throw new ContactProvenanceLostError(contactId);
  const set: Record<string, unknown> = {
    lastSeenAt: new Date(),
    updatedAt: new Date(),
  };
  if (ctx.hasPatch) set.properties = mergePropertiesSql(ctx.patch);
  await tx.update(contacts).set(set).where(eq(contacts.id, row.id));
  return {
    id: row.id,
    resolvedKey: contactKey(row),
    created: false,
    linked: false,
    merged: false,
  };
}

/**
 * Follow the server-authored merge-alias chain from a (soft-deleted loser)
 * `contacts.id` to the live SURVIVOR row, re-locking each hop `FOR UPDATE`.
 * Bounded (merge-of-a-merge) to a small cap. Keyed on `from_contact_id` — the
 * unforgeable row id, never a value — so an attacker-plantable key can never
 * steer it. Returns the live survivor or null (hard-deleted / chain broken).
 */
async function followToSurvivor(
  tx: Tx,
  lostId: string,
): Promise<ContactRow | null> {
  let cursor = lostId;
  for (let i = 0; i < 8; i++) {
    const alias = (
      await tx
        .select({ contactId: contactAliases.contactId })
        .from(contactAliases)
        .where(eq(contactAliases.fromContactId, cursor))
        .limit(1)
    )[0];
    if (!alias?.contactId) return null;
    const survivor: ContactRow | undefined = (
      await tx
        .select()
        .from(contacts)
        .where(eq(contacts.id, alias.contactId))
        .for("update")
        .limit(1)
    )[0];
    if (!survivor) return null;
    if (!survivor.deletedAt) return survivor;
    cursor = alias.contactId;
  }
  return null;
}

/**
 * Top-level property keys whose object value is DEEP-merged (one level) rather
 * than wholly replaced. The §2.1 shallow `||` contract clobbers a top-level key
 * outright, so a nested metadata object (e.g. the Discord connector's
 * `properties.discord`) would lose every field the current event doesn't carry
 * (a reaction knows `last_seen` but not `username`, so it would erase a
 * previously-captured `username`). Listing the key here makes ONLY that key
 * additive — siblings stay strictly shallow, preserving the documented contract
 * for everything else. NON-KEY metadata only; never an identity-resolution key.
 */
const DEEP_MERGE_KEYS = ["discord", "telegram"] as const;

/**
 * Merge `patch` onto the existing jsonb properties (§2.1 contract): additive
 * `COALESCE(existing,'{}') || patch` where the patch wins on key conflict AND an
 * explicit `null` value in the patch CLEARS that key (it is not stored as JSON
 * null). `jsonb_strip_nulls` over the merged result drops every null-valued key
 * — so `{ plan: null }` removes `plan` rather than leaving `"plan": null`.
 *
 * Caveat: `jsonb_strip_nulls` also strips any PRE-EXISTING null-valued keys on
 * the contact, which is the intended "null === unset" model (the condition
 * engine already treats JSON null and absent identically).
 *
 * EXCEPTION — keys in {@link DEEP_MERGE_KEYS} that carry an object value are
 * merged ONE level deep: `existing.discord || patch.discord` instead of the
 * top-level `||` replacing `discord` wholesale. Postgres has no recursive `||`,
 * so we build the deep-merged sub-object explicitly and overlay it last. A
 * non-object value for such a key (or an absent one) falls through to the normal
 * shallow merge untouched.
 */
function mergePropertiesSql(patch: Record<string, unknown>) {
  let merged = sql`COALESCE(${contacts.properties}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;
  for (const key of DEEP_MERGE_KEYS) {
    const sub = patch[key];
    if (sub && typeof sub === "object" && !Array.isArray(sub)) {
      // existing[key] (already an object or absent) || patch[key] — the prior
      // sub-object's fields survive any field the current patch omits.
      // `${key}` is cast to ::text: jsonb_build_object is VARIADIC "any" and `->`
      // is overloaded (text key vs int index), so an untyped bound parameter
      // can't have its type inferred ("could not determine data type of $n").
      merged = sql`${merged} || jsonb_build_object(${key}::text, COALESCE(${contacts.properties} -> ${key}::text, '{}'::jsonb) || ${JSON.stringify(sub)}::jsonb)`;
    }
  }
  return sql`jsonb_strip_nulls(${merged})`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/**
 * Spread-merge one `layer` onto the accumulated `acc` (incoming wins per key),
 * the in-memory analogue of {@link mergePropertiesSql}'s deep-merge exception
 * for the collide-MERGE fold (which folds properties via JS spread, not SQL).
 * For each {@link DEEP_MERGE_KEYS} key that is an object on BOTH `acc` and the
 * incoming `layer`, the sub-objects are themselves shallow-merged (incoming
 * wins per sub-key) so the layer can't clobber fields the accumulator already
 * holds — must read the PRE-spread `acc` value, hence a fresh result object.
 */
function foldLayer(
  acc: Record<string, unknown>,
  layer: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...acc, ...layer };
  for (const key of DEEP_MERGE_KEYS) {
    const a = acc[key];
    const b = layer[key];
    if (isPlainObject(a) && isPlainObject(b)) {
      out[key] = { ...a, ...b };
    }
  }
  return out;
}

/**
 * The JS analogue of {@link mergePropertiesSql} for the in-memory merge-fold:
 * spread-merge then drop null-valued keys so explicit null clears a key (§2.1).
 */
function stripNulls(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v !== null) out[k] = v;
  }
  return out;
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
export function contactKey(row: ContactRow): string {
  return row.externalId ?? row.anonymousId ?? row.id;
}

/**
 * The SQL analogue of {@link contactKey}: the canonical text user_id key as a
 * `coalesce(external_id, anonymous_id, id::text)` fragment. The `::text` cast on
 * `id` (uuid) is required — `coalesce(text, text, uuid)` is rejected by Postgres
 * (42804). Used by every set-based query that projects/joins on the resolved key
 * (bucket backfill + reconcile) so the cast lives in exactly one place.
 */
export function contactKeySql() {
  return sql<string>`coalesce(${contacts.externalId}, ${contacts.anonymousId}, ${contacts.id}::text)`;
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
  discordId?: string;
  contactProperties?: Record<string, unknown>;
  /**
   * PUBLISHABLE (browser, pk_) safety clamp (§Phase 1 GAP-1). When set, an
   * anon-only write (no `userId`/`email`/`discordId`) may ONLY create or update
   * its own anonymous-only contact: it is forbidden from filling-in-linking to,
   * or merging with, any contact that already carries an `external_id`/`email`,
   * and from driving a collide-MERGE — throwing {@link
   * PublishableAnonymousMergeError}. The `anonymousId` is browser-readable
   * (`get_distinct_id()`), so without this clamp a pk_ key could forge events as
   * / poison a victim's identified contact via the anon resolution arm. The
   * secret-key path NEVER sets this, so its behavior is byte-for-byte unchanged.
   */
  restrictToAnonymous?: boolean;
  /**
   * ENGINE-INTERNAL provenance — the subject contact's UNFORGEABLE row id
   * (`contacts.id`, a server-minted uuid). Set ONLY by engine-internal re-emit
   * sites that already resolved the subject (ingestEvent's downstream re-ingests,
   * the feed mark/clear re-ingests, journey/bucket re-emits). When present (and
   * uuid-shaped, and not a clamped publishable write), the resolver PINS to that
   * exact row — never value-resolving, never minting — so an internal event whose
   * `userId` is a contact's own canonical key (its anonymous_id/id round-tripping)
   * folds back into that contact instead of minting a phantom `external_id` twin.
   * NEVER settable from a request body: the public `/v1/events`/`/v1/contacts`/
   * `/v1/feed` Zod schemas omit it and their handlers build the resolve call
   * literally, so an attacker cannot forge provenance. Mutually exclusive with
   * `restrictToAnonymous`.
   */
  contactId?: string;
  /**
   * PROVENANCE (best-effort metadata, NOT an identity key): the Source id that
   * created this contact — a Contact Source id ("clay"/"attio") or the ingest
   * `source`. First-touch: written on create, and on a fill-in-link/merge that
   * supplies one ONLY when the resolved row has none; never overwrites an
   * existing value. NEVER participates in key resolution or survivor selection,
   * so it cannot steer identity — a safe non-identity column threaded alongside.
   */
  source?: string;
  /** Timestamp paired with {@link source}; defaults to now() at create time. */
  sourcedAt?: Date;
}): Promise<{
  id: string;
  /**
   * The contact's canonical text user_id key AFTER this resolve
   * (`external_id ?? anonymous_id ?? id`), i.e. {@link contactKey} of the final
   * row — for a merge, the SURVIVOR's key. Lets callers (ingestEvent) key the
   * history tables without a second read-back of the contact row.
   */
  resolvedKey: string;
  created: boolean;
  linked: boolean;
  merged: boolean;
  /**
   * SAFE-to-absorb loser keys (§5.3 MF-2): the anonymous/uuid keys the resolver
   * folded INTO `resolvedKey` this call — populated only on a collide-MERGE or a
   * canonical-key flip that absorbed an anon/uuid key. Callers fan these out via
   * `mergeAnalyticsIdentities({ distinctId: resolvedKey, alias: <key> })`. An
   * `external_id` is NEVER listed here (it carried an identified PostHog person;
   * aliasing it is the merge PostHog refuses — R2/R4); it surfaces in
   * {@link mergedIdentifiedKeys} instead. Empty/absent ⇒ nothing to stitch.
   */
  mergedKeys?: string[];
  /**
   * Loser keys MF-2 could NOT safely absorb — already-identified `external_id`s
   * (and the superseded `external_id` on a key flip). These are the known
   * steady-state twin residual (§10, OQ-1); callers log them as
   * `identity.merge.residual_twin` for observability. Never aliased.
   */
  mergedIdentifiedKeys?: string[];
}> {
  const { db, contactProperties } = opts;
  const userId = opts.userId?.trim() || undefined;
  const email = opts.email ? normalizeEmail(opts.email) : undefined;
  const anonymousId = opts.anonymousId?.trim() || undefined;
  const discordId = opts.discordId?.trim() || undefined;
  const contactId = opts.contactId?.trim() || undefined;
  const source = opts.source?.trim() || undefined;
  const sourcedAt = opts.sourcedAt;
  // §Phase 1 GAP-1: the publishable clamp only bites an ANON-ONLY write (the
  // only shape a token-less pk_ key can produce — the gate 403s any
  // email/userId without a verified userToken before we get here). An identified
  // arm (token-authorized userId, or the secret path) is never clamped.
  const restrictToAnonymous =
    opts.restrictToAnonymous === true &&
    !userId &&
    !email &&
    !discordId &&
    !!anonymousId;

  const keys: ResolveKey[] = [];
  if (userId) keys.push({ kind: "external", value: userId });
  if (email) keys.push({ kind: "email", value: email });
  if (anonymousId) keys.push({ kind: "anonymous", value: anonymousId });
  if (discordId) keys.push({ kind: "discord", value: discordId });

  if (keys.length === 0) {
    throw new Error(
      "resolveOrCreateContact requires at least one of userId, email, " +
        "anonymousId, discordId",
    );
  }

  const patch = contactProperties ?? {};
  const hasPatch = Object.keys(patch).length > 0;

  return db.transaction(async (tx) => {
    // (−1) ENGINE-INTERNAL PROVENANCE PIN. A uuid-shaped `contactId` from a
    // trusted internal re-emit pins resolution to that exact row (no value-key
    // probe, no mint), so a contact's own canonical key round-tripping back as a
    // `userId` folds into it instead of minting a phantom `external_id` twin.
    // Gated on `!restrictToAnonymous` (mutually exclusive with the publishable
    // clamp — a clamped pk_ write can never carry provenance) so it is never an
    // attacker-reachable path. Runs BEFORE the value-key advisory locks: the pin
    // serializes on the concrete row PK via `FOR UPDATE`, not on value locks.
    if (contactId && UUID_REGEX.test(contactId) && !restrictToAnonymous) {
      return resolveByContactId(tx, contactId, { patch, hasPatch });
    }

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
          discordId: discordId ?? null,
          // First-touch provenance: stamp source (+ paired sourcedAt) on the
          // brand-new row; both stay null when no source was supplied.
          source: source ?? null,
          sourcedAt: source ? (sourcedAt ?? new Date()) : null,
          // §2.1: explicit null clears a key — never persist a null-valued prop.
          properties: stripNulls(patch),
        })
        .returning();
      const createdRow = inserted[0];
      if (!createdRow) throw new Error("Contact insert returned no row");
      return {
        id: createdRow.id,
        resolvedKey: contactKey(createdRow),
        created: true,
        linked: false,
        merged: false,
      };
    }

    // --- CASE: fill-in-link (single existing row) ---
    const single = candidates[0];
    if (candidates.length === 1 && single) {
      // §Phase 1 GAP-1: an anon-only publishable write resolved to an EXISTING
      // contact that already carries an identified key (`external_id`/`email`)
      // is a forge/poison attempt — the browser-readable anonymousId pointed at
      // a victim. Refuse to fill-in-link / mutate it. (Resolving to its OWN
      // anonymous-only contact — no external_id, no email — is allowed.)
      if (restrictToAnonymous && (single.externalId || single.email)) {
        throw new PublishableAnonymousMergeError();
      }
      const { id, resolvedKey, mergedKeys, mergedIdentifiedKeys } =
        await fillInLink(tx, single, {
          userId,
          email,
          anonymousId,
          discordId,
          patch,
          hasPatch,
          source,
          sourcedAt,
        });
      return {
        id,
        resolvedKey,
        created: false,
        linked: true,
        merged: false,
        mergedKeys,
        mergedIdentifiedKeys,
      };
    }

    // --- CASE: collide-MERGE (2-3 distinct rows) ---
    // §Phase 1 GAP-1: an anon-only publishable write must NEVER drive a merge —
    // the browser-readable anonymousId would let an attacker fold two of a
    // victim's contacts together (identity-graph corruption). Refuse.
    if (restrictToAnonymous) {
      throw new PublishableAnonymousMergeError();
    }
    const { id, resolvedKey, mergedKeys, mergedIdentifiedKeys } =
      await mergeContacts(tx, candidates, {
        userId,
        email,
        anonymousId,
        discordId,
        patch,
        hasPatch,
        source,
        sourcedAt,
      });
    return {
      id,
      resolvedKey,
      created: false,
      linked: true,
      merged: true,
      mergedKeys,
      mergedIdentifiedKeys,
    };
  });
}

interface ResolveCtx {
  userId?: string;
  email?: string;
  anonymousId?: string;
  discordId?: string;
  patch: Record<string, unknown>;
  hasPatch: boolean;
  /** First-touch provenance (see {@link resolveOrCreateContact} `source`). */
  source?: string;
  sourcedAt?: Date;
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
): Promise<{
  id: string;
  resolvedKey: string;
  mergedKeys?: string[];
  mergedIdentifiedKeys?: string[];
}> {
  const set: Record<string, unknown> = {
    lastSeenAt: new Date(),
    updatedAt: new Date(),
  };
  const promoted: ResolveKey[] = [];

  // The contact's canonical string key BEFORE this fill (external_id ??
  // anonymous_id ?? id). Attaching an external_id (or anonymous_id where none
  // existed) flips this key — its existing string-keyed history must follow
  // (risk 1), else entry-limit guards / history checks query under the new key
  // and silently miss the pre-link history.
  const oldKey = contactKey(row);
  let nextExternalId = row.externalId;
  let nextAnonymousId = row.anonymousId;

  if (ctx.userId && !row.externalId) {
    set.externalId = ctx.userId;
    nextExternalId = ctx.userId;
    promoted.push({ kind: "external", value: ctx.userId });
  }
  if (ctx.email && !row.email) {
    set.email = ctx.email;
    promoted.push({ kind: "email", value: ctx.email });
  }
  // discord_id is an attachable resolvable key but NEVER the canonical key
  // (external_id ?? anonymous_id ?? id), so it does NOT touch
  // nextExternalId/nextAnonymousId — gaining it never flips the canonical key,
  // so no own-history re-point follows.
  if (ctx.discordId && !row.discordId) {
    set.discordId = ctx.discordId;
    promoted.push({ kind: "discord", value: ctx.discordId });
  }
  if (ctx.anonymousId && !row.anonymousId) {
    set.anonymousId = ctx.anonymousId;
    nextAnonymousId = ctx.anonymousId;
    promoted.push({ kind: "anonymous", value: ctx.anonymousId });
  }
  // First-touch provenance: only stamp when the row has none, so an inbound
  // contact that a Source later re-touches keeps its original origin.
  if (ctx.source && !row.source) {
    set.source = ctx.source;
    set.sourcedAt = ctx.sourcedAt ?? new Date();
  }
  if (ctx.hasPatch) {
    set.properties = mergePropertiesSql(ctx.patch);
  }

  await tx.update(contacts).set(set).where(eq(contacts.id, row.id));

  // Re-point the contact's own history if the canonical key flipped. The
  // updated row (with its new email/keys) is what foldJourneyStates/email_sends
  // denormalize into.
  const newKey = nextExternalId ?? nextAnonymousId ?? row.id;
  // §5.3 emission point 2 (canonical-key flip): when the key flips, the OLD key
  // is folded into the NEW one. MF-3 gate — only emit a merge when `oldKey` was
  // an anonymous/uuid key (never an `external_id` being superseded; that is the
  // twin case, OQ-1). In practice a flip in fillInLink only fires when the row
  // had NO external_id (attaching one never happens to an already-external row),
  // so `oldKey` is structurally always anon/uuid here — the explicit gate guards
  // the invariant regardless.
  let mergedKeys: string[] | undefined;
  let mergedIdentifiedKeys: string[] | undefined;
  if (newKey !== oldKey) {
    const updatedRow: ContactRow = {
      ...row,
      externalId: nextExternalId,
      anonymousId: nextAnonymousId,
      email: (set.email as string | undefined) ?? row.email,
    };
    await repointOwnHistory(tx, oldKey, newKey, updatedRow);

    const oldKeyWasExternalId =
      row.externalId != null && oldKey === row.externalId;
    if (oldKeyWasExternalId) {
      mergedIdentifiedKeys = [oldKey];
    } else {
      mergedKeys = [oldKey];
    }
  }

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

  // `newKey` IS the post-fill canonical key (external_id ?? anonymous_id ?? id) —
  // the same value the old read-back derived.
  return { id: row.id, resolvedKey: newKey, mergedKeys, mergedIdentifiedKeys };
}

/**
 * 2-3 distinct rows collide. Pick the survivor (SURVIVOR RULE) and execute the
 * LOCKED 9-step re-point order, ALL in this one tx. Returns survivor id.
 */
async function mergeContacts(
  tx: Tx,
  candidates: ContactRow[],
  ctx: ResolveCtx,
): Promise<{
  id: string;
  resolvedKey: string;
  mergedKeys?: string[];
  mergedIdentifiedKeys?: string[];
}> {
  const { survivor, losers } = pickSurvivor(candidates);
  const survivorKey = contactKey(survivor);

  // §5.3 emission point 1 (collide-MERGE) accumulators. MF-2: a loser's
  // anonymous/uuid key is SAFE to absorb (it never identified a PostHog person);
  // a loser's `external_id` is an already-identified person PostHog refuses to
  // merge on the safe path — it is recorded as the twin residual, NEVER aliased.
  const safeLoserKeys: string[] = [];
  const identifiedLoserKeys: string[] = [];

  for (const loser of losers) {
    const loserStrKeys = [loser.externalId, loser.anonymousId, loser.id].filter(
      (k): k is string => Boolean(k),
    );
    // The id is the last-resort key for a loser that has neither external nor
    // anonymous id (its user_id rows were keyed on contacts.id).
    const loserKeysToRewrite = loserStrKeys;

    // MF-2 split: the SAFE-to-absorb key is the loser's anonymous/uuid key —
    // `loser.anonymousId`, or `loser.id` ONLY when the loser was never
    // identified (no external_id). When the loser HAS an external_id, that
    // external_id was its canonical key, so its events were captured under it
    // (identified) → residual; `loser.id` never carried events in that case, so
    // there is no safe key to alias from it.
    if (loser.externalId) {
      identifiedLoserKeys.push(loser.externalId);
      if (loser.anonymousId) safeLoserKeys.push(loser.anonymousId);
    } else {
      safeLoserKeys.push(loser.anonymousId ?? loser.id);
    }

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
    await foldEmailPreferences(tx, loserKeysToRewrite, survivorKey);

    // (vi-b) deals + crm_links re-point: these carry contact_id uuid FKs
    // (not user keys), which the key rewrites above never touch. Without
    // this, the loser's open deal is orphaned on a soft-deleted row — the
    // survivor's next stage event/trigger would mint a SECOND deal (and a
    // duplicate deal.sold). No unique index involves contact_id, so plain
    // UPDATEs suffice.
    await tx
      .update(deals)
      .set({ contactId: survivor.id })
      .where(eq(deals.contactId, loser.id));
    await tx
      .update(crmLinks)
      .set({ contactId: survivor.id })
      .where(eq(crmLinks.contactId, loser.id));

    // (vi-c) group_memberships FOLD: another contact_id uuid FK the key
    // rewrites never touch. The loser is SOFT-deleted, so `onDelete: cascade`
    // never fires — without this the loser's memberships are stranded on a dead
    // row (the survivor's drawer shows "no groups", and the group's member
    // count/list disagree). uq(group_id, contact_id) forbids a blind rewrite
    // when BOTH already belong to the same group, so fold-then-rewrite.
    await foldGroupMemberships(tx, survivor.id, loser.id);

    // (ix) RECORD aliases for each loser key → survivor.
    await recordMergeAliases(tx, survivor.id, loser);
  }

  // (vii) FOLD properties: survivor wins over losers; then the call's patch wins
  // last. timezone = survivor ?? loser; firstSeenAt = least. DEEP_MERGE_KEYS
  // (e.g. `discord`) are sub-object-merged at each fold layer (foldLayer) so a
  // loser/survivor/patch that carries only a subset of the nested object's
  // fields doesn't clobber the rest — matching mergePropertiesSql's exception.
  let foldedProps: Record<string, unknown> = {};
  for (const loser of losers) {
    foldedProps = foldLayer(
      foldedProps,
      (loser.properties ?? {}) as Record<string, unknown>,
    );
  }
  foldedProps = foldLayer(
    foldedProps,
    (survivor.properties ?? {}) as Record<string, unknown>,
  );
  if (ctx.hasPatch) {
    foldedProps = foldLayer(foldedProps, ctx.patch);
  }
  // §2.1: an explicit null in the call's patch clears a key — drop null-valued
  // keys from the folded result (matching mergePropertiesSql's strip-nulls).
  foldedProps = stripNulls(foldedProps);

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
  // discord_id lands on the survivor (from the call or a loser), but it is
  // NEVER the canonical key — so it is intentionally NOT folded into
  // newSurvivorKey below and a discord-only merge does no history re-point. The
  // losers are soft-deleted FIRST (below) so the partial-unique discord_id index
  // is freed before this copy.
  if (!survivor.discordId) {
    const fromLoser = losers.find((l) => l.discordId)?.discordId;
    const next = ctx.discordId ?? fromLoser;
    if (next) survivorSet.discordId = next;
  }
  // Provenance (best-effort): the survivor keeps its own source; only when it
  // has none does it adopt the call's, else the earliest-sourced loser's — so a
  // merge never erases a recorded origin but also never invents survivor state.
  if (!survivor.source) {
    const sourcedLoser = losers
      .filter((l) => l.source)
      .sort(
        (a, b) =>
          (a.sourcedAt?.getTime() ?? Number.POSITIVE_INFINITY) -
          (b.sourcedAt?.getTime() ?? Number.POSITIVE_INFINITY),
      )[0];
    const nextSource = ctx.source ?? sourcedLoser?.source ?? undefined;
    if (nextSource) {
      survivorSet.source = nextSource;
      survivorSet.sourcedAt = ctx.source
        ? (ctx.sourcedAt ?? new Date())
        : (sourcedLoser?.sourcedAt ?? new Date());
    }
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

  // If the survivor's canonical key flipped (it had no external_id/anonymous_id
  // and the merge promoted one from the call/loser), re-point the survivor's OWN
  // history — including everything the loser rewrites just pointed at the old
  // survivorKey — onto the new key (risk 1). Without this, a survivor whose
  // history was keyed on its uuid/anonymous_id is orphaned the moment it gains
  // an external_id mid-merge.
  const newSurvivorKey =
    (survivorSet.externalId as string | undefined) ??
    survivor.externalId ??
    (survivorSet.anonymousId as string | undefined) ??
    survivor.anonymousId ??
    survivor.id;
  if (newSurvivorKey !== survivorKey) {
    const updatedSurvivor: ContactRow = {
      ...survivor,
      externalId:
        (survivorSet.externalId as string | undefined) ?? survivor.externalId,
      anonymousId:
        (survivorSet.anonymousId as string | undefined) ?? survivor.anonymousId,
      email: (survivorSet.email as string | undefined) ?? survivor.email,
    };
    await repointOwnHistory(tx, survivorKey, newSurvivorKey, updatedSurvivor);
  }

  // `newSurvivorKey` IS the post-merge canonical key of the survivor — the same
  // value the old read-back derived for the merged row. The merge folds every
  // loser key into it, so callers fan out `mergeAnalyticsIdentities` aliasing
  // each SAFE loser key into `newSurvivorKey` (§5.3 emission point 1).
  return {
    id: survivor.id,
    resolvedKey: newSurvivorKey,
    mergedKeys: safeLoserKeys.length > 0 ? safeLoserKeys : undefined,
    mergedIdentifiedKeys:
      identifiedLoserKeys.length > 0 ? identifiedLoserKeys : undefined,
  };
}

/**
 * journey_states fold. `uq_user_journey_active` is a PARTIAL unique index on
 * `(user_id, journey_id) WHERE status IN ('active','waiting')` — it constrains
 * only LIVE rows, so terminal rows (completed/failed/exited) may legitimately
 * duplicate across the merged identities. A rewrite of a loser's LIVE row onto
 * the survivor key still collides whenever the survivor already holds a live row
 * for that journey.
 *
 * Fix: build the survivor's occupied (journey_id|status) set over ALL statuses.
 * For active/waiting collisions, EXIT the loser's row first (preserve the
 * survivor's live run) so the rewrite lands an 'exited' (out-of-predicate) row.
 * For any OTHER collision (terminal), DELETE the loser's duplicate — no longer
 * REQUIRED by the constraint (terminal rows are outside the predicate), but kept
 * as hygiene so the survivor doesn't carry two identical terminal rows (which
 * would inflate the count()-based ctx.history.journey.entryCount). Rewrite only
 * the non-colliding remainder onto the survivor key (+ survivor email). Re-check
 * 'exited' occupancy after exiting so a just-exited loser row that would now
 * duplicate a pre-existing survivor 'exited' row is dropped rather than rewritten.
 */
async function foldJourneyStates(
  tx: Tx,
  survivorKey: string,
  loserKeys: string[],
  survivor: ContactRow,
): Promise<void> {
  const ACTIVE = new Set<string>(["active", "waiting"]);

  // Every (journey_id|status) pair the survivor already holds (ALL statuses).
  const survivorRows = await tx
    .select({
      journeyId: journeyStates.journeyId,
      status: journeyStates.status,
    })
    .from(journeyStates)
    .where(
      and(
        eq(journeyStates.userId, survivorKey),
        isNull(journeyStates.deletedAt),
      ),
    );
  // Running occupied set — mutated as we exit/rewrite loser rows so two loser
  // rows in the same journey/status (3-way merge) can't collide with each other.
  const occupied = new Set(
    survivorRows.map((s) => `${s.journeyId}|${s.status}`),
  );

  const loserRows = await tx
    .select({
      id: journeyStates.id,
      journeyId: journeyStates.journeyId,
      status: journeyStates.status,
    })
    .from(journeyStates)
    .where(
      and(
        inArray(journeyStates.userId, loserKeys),
        isNull(journeyStates.deletedAt),
      ),
    );

  const idsToExit: string[] = [];
  const idsToDelete: string[] = [];
  const idsToRewrite: string[] = [];

  for (const l of loserRows) {
    const key = `${l.journeyId}|${l.status}`;
    if (occupied.has(key)) {
      if (ACTIVE.has(l.status)) {
        // Survivor (or a prior loser) already holds a live row in this
        // journey/status — exit the loser's so the live run continues. Only do
        // so if the resulting 'exited' slot is itself free; otherwise drop it.
        const exitedKey = `${l.journeyId}|exited`;
        if (occupied.has(exitedKey)) {
          idsToDelete.push(l.id);
        } else {
          idsToExit.push(l.id);
          occupied.add(exitedKey);
        }
      } else {
        // Terminal collision (both completed/failed/exited the same journey) —
        // the survivor already records this state; drop the loser duplicate.
        idsToDelete.push(l.id);
      }
    } else {
      // Free slot — rewrite onto the survivor key. Claim it so a sibling loser
      // row in the same journey/status routes to exit/delete instead.
      idsToRewrite.push(l.id);
      occupied.add(key);
    }
  }

  if (idsToDelete.length > 0) {
    await tx
      .delete(journeyStates)
      .where(inArray(journeyStates.id, idsToDelete));
  }

  if (idsToExit.length > 0) {
    await tx
      .update(journeyStates)
      .set({ status: "exited", exitedAt: new Date(), updatedAt: new Date() })
      .where(inArray(journeyStates.id, idsToExit));
  }

  // Rewrite both the originally non-colliding rows AND the just-exited rows onto
  // the survivor key (the exited rows now sit in claimed-free 'exited' slots).
  const rewriteIds = [...idsToRewrite, ...idsToExit];
  if (rewriteIds.length > 0) {
    await tx
      .update(journeyStates)
      .set({
        userId: survivorKey,
        ...(survivor.email ? { userEmail: survivor.email } : {}),
        updatedAt: new Date(),
      })
      .where(inArray(journeyStates.id, rewriteIds));
  }
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
 * group_memberships fold (vi-c). Unlike buckets this join is keyed on the uuid
 * `contact_id`, and it carries no lifecycle (no status/dwell/left_at) — just
 * `role` + `joined_at` — so the fold is a plain dedupe-then-rewrite:
 *   1. DROP the loser's membership in any group the survivor ALREADY belongs to
 *      (uq(group_id, contact_id) forbids two rows for the same (group, contact);
 *      the survivor's row wins, keeping its authoritative role/joinedAt).
 *   2. Re-point the rest onto the survivor.
 * Hard-delete (not soft-leave) matches how a membership is removed everywhere
 * else in the group service.
 */
async function foldGroupMemberships(
  tx: Tx,
  survivorId: string,
  loserId: string,
): Promise<void> {
  const survivorGroups = await tx
    .select({ groupId: groupMemberships.groupId })
    .from(groupMemberships)
    .where(eq(groupMemberships.contactId, survivorId));

  const occupied = survivorGroups.map((g) => g.groupId);

  if (occupied.length > 0) {
    await tx
      .delete(groupMemberships)
      .where(
        and(
          eq(groupMemberships.contactId, loserId),
          inArray(groupMemberships.groupId, occupied),
        ),
      );
  }

  await tx
    .update(groupMemberships)
    .set({ contactId: survivorId, updatedAt: new Date() })
    .where(eq(groupMemberships.contactId, loserId));
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
  loserKeys: string[],
  survivorKey: string,
): Promise<void> {
  if (loserKeys.length === 0) return;

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

/**
 * Re-point a contact's OWN string-keyed history when its canonical key flips
 * (risk 1). resolvedKey downstream is `external_id ?? anonymous_id ?? id`, so
 * when fill-in-link attaches an external_id to a previously email-only/anon
 * contact (or merge promotes the survivor's external_id), the contact's
 * canonical key changes and its existing user_events/journey_states/email_sends/
 * bucket_memberships/email_preferences rows (keyed on the OLD key) would be
 * silently orphaned. Rewrite them from `oldKey` to `newKey`, applying the SAME
 * active/terminal dedupe as the merge fold so the rewrite can't violate
 * uq_user_journey_active / uq_user_bucket_active / uq(user_id,email).
 *
 * No-op when oldKey === newKey (the canonical key did not change).
 */
async function repointOwnHistory(
  tx: Tx,
  oldKey: string,
  newKey: string,
  row: ContactRow,
): Promise<void> {
  if (oldKey === newKey) return;

  // user_events: no unique constraint on user_id — blind rewrite.
  await tx
    .update(userEvents)
    .set({ userId: newKey })
    .where(eq(userEvents.userId, oldKey));

  // journey_states + bucket_memberships: dedupe against the survivor/new key's
  // existing rows (the folds already handle the collision logic).
  await foldJourneyStates(tx, newKey, [oldKey], row);
  await foldBucketMemberships(tx, newKey, [oldKey]);

  // email_sends: no unique constraint on user_id — blind rewrite.
  await tx
    .update(emailSends)
    .set({
      userId: newKey,
      ...(row.email ? { userEmail: row.email } : {}),
    })
    .where(eq(emailSends.userId, oldKey));

  // email_preferences: FOLD into the new key's rows (uq(user_id, email)).
  await foldEmailPreferences(tx, [oldKey], newKey);
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
  // discord_id is a resolvable key, so a stale loser snowflake must still
  // resolve to the survivor after the soft-delete takes the loser out of
  // findByKey's direct lookup. Additive — it never conflicts with the
  // external/anonymous id-fallback alias below (a discord-only loser produces
  // BOTH this discord alias AND the id→external alias).
  if (loser.discordId) {
    aliasRows.push({
      contactId: survivorId,
      aliasKind: "discord",
      aliasValue: loser.discordId,
      fromContactId: loser.id,
      reason: "merge",
    });
  }
  // When the loser had neither external_id nor anonymous_id, its CANONICAL key
  // (`external_id ?? anonymous_id ?? id`) was its row id — and that key has
  // circulated (Hatchet payloads, outbound `userId`s, `hs_t` tokens). Alias it
  // as an external key so a round-trip still resolves to the survivor after the
  // soft-delete takes the row out of findByKey's id fallback.
  if (!loser.externalId && !loser.anonymousId) {
    aliasRows.push({
      contactId: survivorId,
      aliasKind: "external",
      aliasValue: loser.id,
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
  discordId?: string;
  properties?: Record<string, unknown>;
  /** First-touch provenance (see {@link resolveOrCreateContact} `source`). */
  source?: string;
  sourcedAt?: Date;
}): Promise<{
  id: string;
  resolvedKey: string;
  created: boolean;
  linked: boolean;
  merged: boolean;
  /** §5.3 MF-2: safe-to-absorb loser keys folded this call (anon/uuid). */
  mergedKeys?: string[];
  /** §5.3 MF-2: already-identified loser keys (twin residual); never aliased. */
  mergedIdentifiedKeys?: string[];
}> {
  return resolveOrCreateContact({
    db: opts.db,
    userId: opts.externalId,
    email: opts.email,
    anonymousId: opts.anonymousId,
    discordId: opts.discordId,
    contactProperties: opts.properties,
    source: opts.source,
    sourcedAt: opts.sourcedAt,
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
 *
 * Returns `{ deleted }` plus the soft-deleted row's identity (`id`,
 * `externalId`, `email`) so the delete route can both make its 404 decision
 * (`deleted`) AND emit the `contact.deleted` outbound webhook with the real
 * identity — without a second read-back. `deleted` is false (and the identity
 * fields absent) when no live row matched.
 */
export async function softDeleteContact(opts: {
  db: Database;
  email?: string;
  userId?: string;
}): Promise<{
  deleted: boolean;
  id?: string;
  externalId?: string | null;
  email?: string | null;
}> {
  const { db } = opts;
  const email = opts.email ? normalizeEmail(opts.email) : undefined;
  const userId = opts.userId?.trim() || undefined;

  const clauses = [];
  if (email) clauses.push(eq(contacts.email, email));
  if (userId) clauses.push(eq(contacts.externalId, userId));
  if (clauses.length === 0) return { deleted: false };

  const updated = await db
    .update(contacts)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(or(...clauses), isNull(contacts.deletedAt)))
    .returning({
      id: contacts.id,
      externalId: contacts.externalId,
      email: contacts.email,
    });

  const row = updated[0];
  if (!row) return { deleted: false };

  return {
    deleted: true,
    id: row.id,
    externalId: row.externalId,
    email: row.email,
  };
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
