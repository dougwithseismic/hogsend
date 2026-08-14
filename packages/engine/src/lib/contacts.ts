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
  linkedAccounts,
  userEvents,
} from "@hogsend/db";
import {
  and,
  type Column,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  ne,
  not,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
// The account-link store (PRD 03) is the ONE module allowed to write a
// `linked_accounts` VERSION — this file only consumes its tx-scoped helpers
// (the merge fold, the delete leg) plus one version-free contact_id repoint
// inside `foldLinkedAccounts`. No import cycle: account-links.ts never imports
// this module.
import { emitAccountUnlinked } from "./account-link-emit.js";
import { ingestAccountUnlinked } from "./account-link-ingest.js";
import {
  type ContactUnlinkFact,
  type LinkOwner,
  unlinkAccountInTx,
  unlinkAccountsForContactInTx,
} from "./account-links.js";
import { createLogger } from "./logger.js";

/** Module logger (the house lib idiom — see connector-actions.ts:28). Used only
 * for the alias dual-write's conflict warning; the resolver's option surface
 * stays logger-free. */
const logger = createLogger(process.env.LOG_LEVEL);

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `contact_aliases.reason` values written by PRD 02's dual-write and backfill.
 * One exported const per value so the writer (here), the backfill job
 * (`workflows/identity-alias-backfill.ts`) and any rollback statement share a
 * single spelling — `reason` is bare text with no CHECK, so a typo would
 * silently escape a string-matched filter. The pre-existing `'promote'` /
 * `'merge'` literals are provenance events and are deliberately not touched.
 */
export const ALIAS_REASON_RESOLVE = "resolve";
export const ALIAS_REASON_BACKFILL = "backfill";

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
 * Thrown by the resolver when a supplied identity key's kind is absent from
 * the caller's declared `ResolvePolicy.trustedKinds` (PRD 06 T5).
 *
 * INTERNAL — deliberately NOT exported from `index.ts`. This is defence in
 * depth, not a request-shaping tool: every browser-facing route is already
 * gated one layer up (`gatePublishableIdentity` for `/v1/events`,
 * `/v1/contacts` and the `lists` handlers; `arrive`'s keys come from the
 * first-write-wins stamp; `feed`'s re-ingests are engine-internal full-trust
 * with a server-derived subject — the three-legged L3 proof), so this throw
 * is unreachable from every route today. It exists to catch a FUTURE route
 * that forgets the gate — a caller bug, surfaced loudly in dev, never a
 * condition for consumers to branch on. Thrown BEFORE any advisory lock is
 * taken and before the transaction opens, so a refused call leaves no lock
 * and no row behind.
 */
export class UntrustedKeyKindError extends Error {
  constructor(kind: string, trustedKinds: readonly string[]) {
    super(
      `identity key kind "${kind}" is not in this caller's declared ` +
        `trustedKinds [${trustedKinds.join(", ")}] — the caller supplied a ` +
        "key it is not authorized to assert (PRD 06 T5)",
    );
    this.name = "UntrustedKeyKindError";
  }
}

/**
 * True when `value` names an IDENTIFIED person: a live contact's canonical
 * `external_id` (or its `email` when that is its canonical key), OR — via the
 * identity table — any non-anonymous key a live contact holds, including a
 * merged loser's STALE key (PRD 07 T6b). Such a value must NOT be claimable by
 * a token-less publishable/unauthenticated caller as an "anon id" (the
 * feed-read and arrival-stamp forgery guard).
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
  // Alias leg (PRD 07 T6b). The identity table sees what the columns cannot:
  // a merged loser's STALE key stays aliased to its live survivor while the
  // loser row is soft-deleted and invisible to the column probe below. Any
  // non-anonymous alias on a live contact names an identified person — reject.
  // (Deliberately stricter than the column leg in one case: an identified
  // contact's email is rejected even when an `external_id` exists.)
  const aliasHit = await db
    .select({ id: contactAliases.id })
    .from(contactAliases)
    .innerJoin(contacts, eq(contacts.id, contactAliases.contactId))
    .where(
      and(
        eq(contactAliases.aliasValue, value),
        ne(contactAliases.aliasKind, "anonymous"),
        isNull(contacts.deletedAt),
      ),
    )
    .limit(1);
  if (aliasHit.length > 0) return true;

  // Column leg — the unbackfilled-registry backstop. A deployment that
  // upgraded past 0.57 without running `identity-alias-backfill` holds
  // pre-upgrade keys in the columns only; a guard that read aliases alone
  // would fail OPEN there. Keep both legs (PRD 07 re-spec).
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
 * True when some OTHER live contact's canonical key (`external_id ??
 * anonymous_id ?? id`) is exactly `value` — i.e. `value` already keys that
 * person's string-keyed history.
 *
 * This is the precondition for ADOPTING history, and it is strictly stronger
 * than "no contact resolved by this anonymous key". Resolution probes the
 * ANONYMOUS namespace (`contacts.anonymous_id` + anonymous aliases), so a value
 * that is another contact's `external_id` — or, for a contact with neither key,
 * its row uuid — misses every probe while still keying all of that contact's
 * rows. Adopting on a resolution miss alone therefore lets a caller name
 * someone else's canonical key as their own `anonymousId` and have that
 * person's events, journey states, bucket memberships and sends repointed onto
 * the caller's contact.
 *
 * ATTACHING a key (writing the column / recording an alias) is not the same act
 * as ADOPTING one: attaching adds a resolution edge, adoption MOVES rows. Only
 * adoption is gated on this.
 */
async function keysAnotherContact(
  tx: Tx,
  value: string,
  selfId: string,
): Promise<boolean> {
  // Alias leg (PRD 07 T6b). A value claimed by ANOTHER live contact — under
  // any kind — refuses the claim: same-kind re-claims are already blocked by
  // the `(kind, value)` unique index, so what this leg actually stops is the
  // CROSS-kind claim (someone else's key asserted as this caller's
  // `anonymousId`), which is the adoption-theft setup. It also sees a merged
  // loser's stale keys (aliased to the live survivor; the soft-deleted loser
  // row is invisible to the column probe below). The live-contact join keeps
  // the merge arm working: mid-merge, the loser is already soft-deleted, so
  // its own alias rows don't refuse the survivor's claim of its keys.
  const aliasHit = await tx
    .select({ id: contactAliases.id })
    .from(contactAliases)
    .innerJoin(contacts, eq(contacts.id, contactAliases.contactId))
    .where(
      and(
        eq(contactAliases.aliasValue, value),
        ne(contactAliases.contactId, selfId),
        isNull(contacts.deletedAt),
      ),
    )
    .limit(1);
  if (aliasHit.length > 0) return true;

  // Column leg — the unbackfilled-registry backstop (see
  // `collidesWithIdentified`).
  const rows = await tx
    .select({
      id: contacts.id,
      externalId: contacts.externalId,
      anonymousId: contacts.anonymousId,
    })
    .from(contacts)
    .where(
      and(
        or(
          eq(contacts.externalId, value),
          eq(contacts.anonymousId, value),
          // A contact with neither key is keyed on its row uuid, and that key
          // leaves the system (Hatchet payloads, hs_t tokens), so it is guessable
          // in a way a browser-local anon id is not.
          ...(UUID_REGEX.test(value) ? [eq(contacts.id, value)] : []),
        ),
        isNull(contacts.deletedAt),
      ),
    );
  for (const r of rows) {
    if (r.id === selfId) continue;
    if ((r.externalId ?? r.anonymousId ?? r.id) === value) return true;
  }
  return false;
}

/**
 * PRD 03 — THE single claim executor. Every supplied identity key the columns
 * cannot (or should not) hold becomes an identity row through this one path,
 * on the fill-in-link arm and the merge arm alike. The arms decide WHAT to
 * claim (and whether a free column also gets the legacy dual-write); this
 * function is the only place a claim is gated and recorded — the per-arm
 * inline-side-effect shape is what let the pre-PRD-03 if-arm ship ungated.
 *
 * Gate: `external` and `anonymous` claims are refused when the value is
 * another live contact's CANONICAL key (`keysAnotherContact`) — resolution
 * probes only the kind's own namespace, so "no candidate resolved" does not
 * mean "nobody owns this value", and while history is string-keyed a claim on
 * someone else's canonical key is the setup for theft (the adoption/repoint
 * primitives key on strings until PRD 05). `email`/`discord` need no gate:
 * neither is ever canonical, so neither ever keyed history — nothing to steal.
 * The gate result is memoised per value (`foreignMemo`) so a caller probing
 * the same value twice issues one query.
 *
 * A refused claim is silent + logged (`identity.claim.refused_foreign_key`,
 * kind + contact id, NEVER the value — it is another person's identifier):
 * throwing would 500 an ingest that looks legitimate to its caller.
 *
 * Returns:
 *  - "refused" — foreign canonical key; the caller must skip the column write,
 *    the adoption and the `mergedKeys` report as well.
 *  - "claimed" — THIS call inserted the `(kind, value)` row. The first-claim
 *    signal adoption reads: structural idempotence via the unique index +
 *    `returning()`, replacing the bespoke `anonAliasAlreadyHeld` probe (a
 *    repeat resolve conflicts, returns nothing, and re-fires nothing — the
 *    re-stitch-storm guard, now enforced by the index instead of remembered).
 *  - "held" — the row already existed (repeat resolve, or a merge/backfill
 *    wrote it first); nothing to adopt or report.
 */
async function claimIdentityKey(
  tx: Tx,
  row: ContactRow,
  key: ResolveKey,
  foreignMemo: Map<string, boolean>,
): Promise<"refused" | "claimed" | "held"> {
  if (key.kind === "external" || key.kind === "anonymous") {
    let foreign = foreignMemo.get(key.value);
    if (foreign === undefined) {
      foreign = await keysAnotherContact(tx, key.value, row.id);
      foreignMemo.set(key.value, foreign);
    }
    if (foreign) {
      logger.warn("identity.claim.refused_foreign_key", {
        kind: key.kind,
        contactId: row.id,
      });
      return "refused";
    }
  }

  const inserted = await tx
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
    })
    .returning({ id: contactAliases.id });
  return inserted.length > 0 ? "claimed" : "held";
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

export async function resolveContact(opts: { db: Database; id: string }) {
  const { db, id } = opts;
  // uuid → primary-key read (a merged-away row uuid stays a miss; that arm is
  // a PK read, not an identity probe). Anything else is an EXTERNAL key:
  // column probe first, then the identity table, so a stale (merged-away)
  // external id resolves its SURVIVOR (PRD 07 T7).
  if (UUID_REGEX.test(id)) {
    const rows = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, id), isNull(contacts.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }
  const rows = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.externalId, id), isNull(contacts.deletedAt)))
    .limit(1);
  return rows[0] ?? (await resolveViaAlias(db, "external", id));
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
  // The alias leg (PRD 07 T6b) finds a contact by ANY of its historical keys —
  // a merged loser's old email, a second device's anon id — which the one-slot
  // columns cannot. The column legs stay: strictly-more-results, and they are
  // the backstop on a deployment whose alias backfill never ran.
  return or(
    ilike(contacts.email, `%${search}%`),
    ilike(contacts.externalId, `%${search}%`),
    ilike(contacts.anonymousId, `%${search}%`),
    ilike(contacts.discordId, `%${search}%`),
    sql`exists (select 1 from ${contactAliases}
      where ${contactAliases.contactId} = ${contacts.id}
        and ${contactAliases.aliasValue} ilike ${`%${search}%`})`,
  );
}

/**
 * "Has this person EVER identified?" — the single display predicate behind
 * `GET /v1/admin/contacts?identity=…` and Studio's identified-only default.
 *
 * FOUR columns, not two. `external_id` and `email` are the obvious pair, but
 * `contacts.discord_id` and `contacts.phone` are documented in the schema as
 * RESOLVABLE identity keys, NOT properties (`schema/contacts.ts:34-53`), each
 * carrying its own live partial-unique index. A Discord-linked community
 * member and an SMS-only subscriber have both identified; dropping either leg
 * makes a real customer vanish from the default list. `anonymous_id` is
 * deliberately absent — it is exactly what this predicate exists to exclude.
 *
 * The complement is `not(identifiedContactFilter())`, and it is EXACT: every
 * operand is `IS NOT NULL`, which never yields NULL, so three-valued logic
 * cannot swallow a row under the negation. Hence
 * `total(identified) + total(anonymous) === total(all)`, and the rare keyless
 * row (no identity column at all — the engine already handles those by uuid)
 * lands in `anonymous`, which is the truthful bucket for it.
 *
 * FUTURE (PRD 02/03) — the swap is this function body and nothing else:
 *
 * ```ts
 * or(
 *   sql`exists (select 1 from contact_aliases ca
 *               where ca.contact_id = ${contacts.id} and ca.alias_kind <> 'anonymous')`,
 *   isNotNull(contacts.phone),
 * )
 * ```
 *
 * Two ordering rules govern it. (1) It is correct only AFTER PRD 02's alias
 * backfill is verified — today `contact_aliases` is written only on
 * merge/promote, so the `EXISTS` would read as "never identified" for almost
 * everyone and empty the list. (2) The `phone` leg SURVIVES the swap: PRD 02
 * deliberately excludes phone from both the backfill and the dual-write
 * (phone is not yet a merge-participating `Kind`), so a phone-only contact has
 * no non-anonymous alias row. That leg retires only when phone joins the
 * identity table.
 *
 * PRD 07 verdict (2026-07-29): the swap is NOT taken. The rescope keeps the
 * columns as written mirrors forever, so these `IS NOT NULL` legs stay exact —
 * and the swap would empty the list on a deployment whose alias backfill never
 * ran, for zero benefit. Revisit only if the columns ever actually die.
 */
export function identifiedContactFilter(): SQL {
  // `or()` is typed `SQL | undefined` because it tolerates undefined operands.
  // All four here are statically present, so the result is never undefined —
  // the assertion narrows the type, it does not assert anything at runtime.
  return or(
    isNotNull(contacts.externalId),
    isNotNull(contacts.email),
    isNotNull(contacts.discordId),
    isNotNull(contacts.phone),
  ) as SQL;
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

/**
 * The four key kinds identity resolution understands (PRD 06 — the module-local
 * `Kind` promoted to the public API). `phone` is deliberately absent: it is not
 * yet a merge-participating kind (SMS STOP resolves a contact by a direct
 * `contacts.phone` lookup, outside the resolver).
 */
export type IdentityKind = "external" | "email" | "anonymous" | "discord";

// Module-local shorthand retained so this file's existing signatures
// (`ResolveKey`, `resolveViaAlias`, …) don't churn.
export type Kind = IdentityKind;

/**
 * Explicit, caller-declared trust for ONE resolve call (PRD 06). Replaces the
 * legacy inference from `restrictToAnonymous`/`allowCreate` plus *which keys
 * happen to be present*: trust travels with the call instead of being
 * reconstructed inside the resolver. Pass at most one shape — `policy` OR the
 * legacy fields — never both (the resolver throws; no precedence rule exists).
 */
export interface ResolvePolicy {
  /**
   * MINT policy. `"on-miss"` is the historic create arm: when no live contact
   * owns any supplied key, insert one. `"refuse-on-miss"` is the D1 observation
   * refusal: return `{ id: null }` and mint nothing (reachable only through
   * {@link resolveContactNoCreate}). The refusal KEY is never accepted from the
   * caller — it stays DERIVED (`userId ?? anonymousId`) and D8-validated inside
   * `resolveContactNoCreate`: a caller-supplied key could diverge from what the
   * create arm would have made canonical and strand the event's history under a
   * key no contact will ever own (A1).
   */
  create: "on-miss" | "refuse-on-miss";
  /**
   * MERGE/ATTACH policy. `"any"` is the historic unrestricted behavior.
   * `"anonymous-only"` is the publishable clamp (§Phase 1 GAP-1, the legacy
   * `restrictToAnonymous`): it bites only when the supplied keys are EXACTLY
   * one `anonymous` key, and then refuses to fill-in-link to / merge with an
   * identified contact and ignores the `contactId` provenance pin.
   *
   * `"never-identified-pair"` is RESERVED and NOT IMPLEMENTED — selecting it
   * throws until it is. It names the rule the current vocabulary cannot
   * express: never merge two ALREADY-IDENTIFIED persons. The concrete harm it
   * will one day prevent: person A signs in on a browser (the browser's anon
   * id `V` is claimed onto A's identified contact), then person B signs in on
   * the SAME browser without `reset()` — the resolve `{ userId: B,
   * anonymousId: V }` finds two candidates, both identified, and
   * `mergeContacts` folds two real humans into one: {@link pickSurvivor}
   * prefers identified-then-oldest and never checks whether BOTH candidates
   * are identified. Shared computers, family devices and kiosks make this an
   * ordinary event, not an attack. Fixing it is a behaviour change and out of
   * this refactor's scope (D8); no built-in caller selects the value.
   */
  allowMerge: "any" | "anonymous-only" | "never-identified-pair";
  /**
   * The key kinds THIS CALLER is authorized to assert. ENFORCED (PRD 06 T5):
   * a supplied key whose kind is absent from this list throws
   * `UntrustedKeyKindError` — after the keys array is built, before any
   * advisory lock is taken and before the transaction opens. The default when
   * no policy is supplied is all four kinds, so legacy-shape callers are
   * unaffected.
   */
  trustedKinds: readonly IdentityKind[];
}

/** Every kind — the legacy shapes' implicit trust grant (the server default).
 * Exported (module-level, not public API) so policy-declaring callers state
 * the full grant without re-spelling the four literals (PRD 06 T3). */
export const ALL_IDENTITY_KINDS: readonly IdentityKind[] = [
  "external",
  "email",
  "anonymous",
  "discord",
];

interface ResolveKey {
  kind: Kind;
  value: string;
}

/** Postgres uuid syntax — guards the `contacts.id` fallback cast below. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Look up the single live contact owning `(kind, value)`. Probe order (PRD 02
 * T5 — the identity table is the source of truth):
 *
 *   1. ALIAS-FIRST — one joined statement over `contact_aliases` → `contacts`.
 *      The `deleted_at IS NULL` predicate lives INSIDE the join on purpose: an
 *      alias whose target is soft-deleted must produce NO row, so the probe
 *      falls through rather than resolving a tombstone (the live-target rule).
 *   2. Identity-column probe — unchanged; covers keys that predate the alias
 *      backfill and keys whose alias row is dead.
 *   3. Row-uuid fallback (external keys only) — unchanged, still last.
 *
 * With an empty `contact_aliases` this behaves exactly as the old column-first
 * order did, which is what makes the flip revertable.
 */
async function findByKey(tx: Tx, key: ResolveKey): Promise<ContactRow | null> {
  // (1) Alias probe FIRST. Single round trip; served by the
  // `contact_aliases_kind_value_idx` unique index plus a PK join.
  const viaAlias = await tx
    .select({ contact: contacts })
    .from(contactAliases)
    .innerJoin(
      contacts,
      and(
        eq(contacts.id, contactAliases.contactId),
        isNull(contacts.deletedAt),
      ),
    )
    .where(
      and(
        eq(contactAliases.aliasKind, key.kind),
        eq(contactAliases.aliasValue, key.value),
      ),
    )
    .limit(1);
  if (viaAlias[0]) return viaAlias[0].contact;

  // (2) Identity-column probe — unchanged.
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
 * The ADOPTION STAMP fragment: `coalesce(<table>.contact_id, :contactId)`.
 *
 * Every statement below that moves a history row's mutable `user_id` string
 * onto an absorbing contact's key ALSO stamps that contact's uuid — so the
 * later read-flip onto `contact_id` leaves no adopted row behind. Two
 * properties make this fragment (rather than a bare `contact_id = :id`) the
 * only correct shape:
 *
 *  - SECURITY, not optimization. The `coalesce` is a NULL guard: it stamps only
 *    rows nobody owns yet (written while the contact did not exist — the whole
 *    point of refusing to mint on observation). A row already carrying ANOTHER
 *    contact's id is left alone, so a mis-gated adoption can never re-parent a
 *    second person's history even if it does move the string key.
 *  - It must ride IN the same UPDATE that rewrites `user_id`. A separate stamp
 *    statement afterwards matches zero rows — the key it would filter on has
 *    already moved — and one before it would need its own scan of the old key.
 *
 * Idempotent by construction: re-running an adoption finds `contact_id` already
 * non-NULL and changes nothing.
 *
 * The `::uuid` cast pins the bound parameter's type the way {@link
 * contactKeySql}'s `::text` does; without it the param arrives untyped and
 * Postgres has to infer it from the coalesce.
 */
function adoptedContactId(column: Column, contactId: string): SQL<string> {
  return sql<string>`coalesce(${column}, ${contactId}::uuid)`;
}

/**
 * How a fold writes its routed rows (PRD 05 T9, narrowed by PRD 07 T7).
 *
 * `user_id` is frozen at its write-time value in BOTH modes — reads no longer
 * consult it, and D9 keeps writing it on inserts. What differs is the stamp:
 *
 * - Merge mode (default): stamp `contact_id` under the {@link adoptedContactId}
 *   NULL guard (loser-OWNED rows are re-pointed wholesale by the merge's
 *   (vi-b-hist) statements, never here) and denormalize the survivor's email
 *   where the table carries one.
 * - `stampOnly` (the adoption path): a plain one-column stamp. The loser scope
 *   is `orphansOnly` (see {@link foldScopes}), so every matched row carries
 *   `contact_id IS NULL` and the stamp cannot re-parent another person's
 *   history.
 */
interface FoldWriteOpts {
  stampOnly?: boolean;
}

/**
 * PRD 05 T3 — "which rows belong to the loser, and which to the survivor", for
 * the three folds below.
 *
 * Migration 0071 adds a CONTACT-scoped partial unique index to `journey_states`,
 * `bucket_memberships` and `email_preferences`. That makes a string-key-only
 * fold unsafe: adoption stamps `contact_id` WITHOUT rewriting `user_id`, so a
 * row the SURVIVOR already owns can sit under a stale key. A fold that looked
 * only at `user_id = survivorKey` would not see it, would call the slot free,
 * and would re-point (or NULL-stamp) a loser row into a second row satisfying
 * the new index — a 23505 raised inside `resolveContact`'s transaction with no
 * handler, which wedges identity resolution for that person permanently (every
 * retry fails identically). So ownership is asked BOTH ways, `user_id` and
 * `contact_id`.
 *
 * `loserId` is the mirror on the other side and is supplied only by the merge
 * path: the adoption path ({@link adoptOrphanHistory}) folds history onto the
 * contact that already owns its key, where the "loser" rows would carry that
 * same `contact_id` and matching on it would swallow the whole contact. The
 * loser test wins the tie — a row is either being adopted or being folded
 * into, never both.
 *
 * `orphansOnly` (the adoption path, PRD 05 T9): the loser side additionally
 * requires `contact_id IS NULL`. This predicate is the anti-theft guard that
 * replaced `keysAnotherContact`'s adoption-gating role — a row another contact
 * owns already carries that owner's id and can never match, so adoption
 * cannot re-parent a second person's history. Never combined with `loserId`
 * (only the merge path supplies one).
 */
function foldScopes(opts: {
  userIdCol: Column;
  contactIdCol: Column;
  survivorKey: string;
  survivorId: string;
  loserKeys: string[];
  loserId?: string;
  orphansOnly?: boolean;
}): { isLoser: SQL; isSurvivor: SQL } {
  // `IS NOT DISTINCT FROM`, never `=`. `contact_id` is nullable, and a plain
  // equality against a NULL column is UNKNOWN, not false — which `NOT (… OR
  // UNKNOWN)` then swallows, silently dropping EVERY contactless row out of the
  // survivor set. That is the occupancy the folds dedupe against, so the folds
  // would stop seeing the rows they exist to protect.
  const sameContact = (id: string): SQL =>
    sql`${opts.contactIdCol} IS NOT DISTINCT FROM ${id}::uuid`;

  const byKey = opts.orphansOnly
    ? (and(
        inArray(opts.userIdCol, opts.loserKeys),
        isNull(opts.contactIdCol),
      ) as SQL)
    : inArray(opts.userIdCol, opts.loserKeys);
  const isLoser = opts.loserId ? or(byKey, sameContact(opts.loserId)) : byKey;
  const isSurvivor = and(
    or(eq(opts.userIdCol, opts.survivorKey), sameContact(opts.survivorId)),
    not(isLoser as SQL),
  );
  return { isLoser: isLoser as SQL, isSurvivor: isSurvivor as SQL };
}

/**
 * The identity keys + options EVERY resolve entry point accepts. Named (rather
 * than inline) so {@link resolveOrCreateContact} and {@link
 * resolveContactNoCreate} declare one option shape over one implementation
 * ({@link resolveContactShared}) and can never drift apart. Purely an
 * extraction — the exported parameter type is structurally unchanged.
 */
interface ResolveContactOptions {
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
   *
   * @deprecated PRD 06 — declare {@link ResolvePolicy} instead:
   * `policy: { allowMerge: "anonymous-only", … }`. Still fully accepted and
   * honoured (removal is a breaking change deferred to a later sweep), but
   * mutually exclusive with `policy` — supplying both shapes throws.
   */
  restrictToAnonymous?: boolean;
  /**
   * Explicit caller trust (PRD 06). Mutually exclusive with the legacy
   * `restrictToAnonymous` field (and, on the internal shared body, the derived
   * `refuseCreateWithKey` channel): supplying both shapes throws — no
   * precedence rule exists. Absent ⇒ the legacy fields (or their defaults)
   * apply unchanged.
   */
  policy?: ResolvePolicy;
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
}

/**
 * One `linked_accounts` soft-unlink the merge fold performed (PRD 04 T2): the
 * loser's live singleton link lost the arbitration to the survivor's. PRD 08
 * emits one `account.unlinked` per entry AFTER the resolve transaction
 * commits; nothing is emitted here (DECISIONS §8). `version` is that pair's
 * OWN next version, a STRING end to end (DECISIONS §5.1).
 */
export interface MergedLinkUnlink {
  provider: string;
  providerUserId: string;
  version: string;
  /** The loser contact that held the soft-unlinked row. */
  contactId: string;
  reason: "relinked";
  /**
   * The owner facts the store read INSIDE the fold's transaction (DECISIONS
   * §15.5). PRD 08's payload carries `userId` (`contactKey()`) and `email`,
   * and neither lives on `linked_accounts` — without carrying them here the
   * post-commit emit would either ship two nulls or bolt a second contacts
   * read on after the lock released, which is no longer the state that
   * committed. `unlinkAccountInTx`'s `unlinked` arm returns it
   * (`account-links.ts:260`) and the fold only narrows to that arm, so the
   * fold copies it straight across — no extra query.
   */
  owner: LinkOwner;
}

/**
 * The shared implementation's result. Identical to
 * {@link resolveOrCreateContact}'s (documented there) EXCEPT that `id` is
 * nullable: the refusal arm returns `null`. The two exported entry points
 * re-narrow it — `resolveOrCreateContact` back to `string`, so its published
 * type never widens (D3).
 */
interface ResolveContactSharedResult {
  id: string | null;
  resolvedKey: string;
  created: boolean;
  linked: boolean;
  merged: boolean;
  mergedKeys?: string[];
  mergedIdentifiedKeys?: string[];
  /** PRD 04: link soft-unlinks a collide-MERGE performed (see
   * {@link MergedLinkUnlink}). Absent when the resolve unlinked nothing. */
  linkUnlinks?: MergedLinkUnlink[];
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
 * …plus a fourth arm reachable ONLY through {@link resolveContactNoCreate}:
 *
 *   - refuse        — no existing row owns any provided key AND the caller
 *                     passed `refuseCreateWithKey`. Returns `id: null` and mints
 *                     nothing (D1: a contact is minted by identity, not by
 *                     observation).
 *
 * INSERT RACE strategy: a `pg_advisory_xact_lock(hashtext(kind||value))` is taken
 * per provided key at the TOP of the tx (before any SELECT). Two concurrent
 * resolves for the same key serialize on the lock, so the second sees the first's
 * insert and links/merges instead of racing a duplicate row. The lock is held
 * until the tx commits/rolls back (xact-scoped) — no manual unlock.
 */
async function resolveContactShared(
  opts: ResolveContactOptions & {
    /**
     * REFUSAL key (D1/D8). When set, the create arm does not insert — it returns
     * `{ id: null, resolvedKey: <this key> }`. The caller
     * ({@link resolveContactNoCreate}) is responsible for supplying the key the
     * create arm WOULD have made canonical, which is why refusal is legal only
     * when the highest-precedence supplied key is `userId` or `anonymousId`:
     * `contactKey = external_id ?? anonymous_id ?? id`, so for any other shape
     * the canonical key is a freshly-minted row uuid that refusal cannot
     * reproduce. Absent ⇒ the historic create-on-miss behavior, unchanged.
     *
     * @deprecated PRD 06 — the legacy internal channel for the derived refusal
     * key. The policy shape re-derives the identical key inside the shared
     * body instead; mutually exclusive with `policy` (supplying both throws).
     */
    refuseCreateWithKey?: string;
  },
): Promise<ResolveContactSharedResult> {
  const { db, contactProperties } = opts;
  const userId = opts.userId?.trim() || undefined;
  const email = opts.email ? normalizeEmail(opts.email) : undefined;
  const anonymousId = opts.anonymousId?.trim() || undefined;
  const discordId = opts.discordId?.trim() || undefined;
  const contactId = opts.contactId?.trim() || undefined;
  const source = opts.source?.trim() || undefined;
  const sourcedAt = opts.sourcedAt;

  // --- POLICY NORMALIZATION (PRD 06 T1) --- EITHER input shape — the explicit
  // `policy` object or the legacy fields — normalises into this ONE local.
  // Supplying both shapes at once is a caller bug and throws: no precedence
  // rule ever ships.
  if (
    opts.policy &&
    (opts.restrictToAnonymous !== undefined ||
      opts.refuseCreateWithKey !== undefined)
  ) {
    throw new Error(
      "resolveContact: pass either `policy` or the legacy fields " +
        "(`restrictToAnonymous` / `allowCreate` / `refuseCreateWithKey`), " +
        "never both — no precedence rule exists",
    );
  }
  if (opts.policy?.allowMerge === "never-identified-pair") {
    throw new Error(
      'ResolvePolicy.allowMerge "never-identified-pair" is reserved and not ' +
        "implemented yet — no caller may select it (see the ResolvePolicy " +
        "docblock for the shared-browser harm it will eventually prevent)",
    );
  }
  const policy: ResolvePolicy = opts.policy ?? {
    create:
      opts.refuseCreateWithKey !== undefined ? "refuse-on-miss" : "on-miss",
    allowMerge: opts.restrictToAnonymous === true ? "anonymous-only" : "any",
    trustedKinds: ALL_IDENTITY_KINDS,
  };
  // The refusal key stays DERIVED, never caller-supplied (PRD 06 A1): the
  // legacy channel carries `resolveContactNoCreate`'s already-D8-validated key
  // verbatim; the policy shape re-derives the IDENTICAL `userId ?? anonymousId`
  // from the same normalized locals above.
  const refuseWithKey =
    policy.create === "on-miss"
      ? undefined
      : (opts.refuseCreateWithKey ?? userId ?? anonymousId);

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

  // --- TRUST ENFORCEMENT (PRD 06 T5) --- Every supplied key's kind must be in
  // the caller's declared `trustedKinds`. Placed AFTER the keys array is built
  // and BEFORE the transaction opens — so a refused call takes no advisory
  // lock, opens no transaction, and writes no row. The default policy (no
  // `policy` supplied) grants all four kinds, so every legacy-shape caller is
  // unaffected. Unreachable from every route today (the three-legged L3
  // unreachability proof — see {@link UntrustedKeyKindError}); this is defence
  // in depth against a future route that forgets the gate.
  for (const key of keys) {
    if (!policy.trustedKinds.includes(key.kind)) {
      throw new UntrustedKeyKindError(key.kind, policy.trustedKinds);
    }
  }

  // §Phase 1 GAP-1: the publishable clamp only bites an ANON-ONLY write (the
  // only shape a token-less pk_ key can produce — the gate 403s any
  // email/userId without a verified userToken before we get here). An identified
  // arm (token-authorized userId, or the secret path) is never clamped.
  // Provably identical to the legacy derivation (`opts.restrictToAnonymous ===
  // true && !userId && !email && !discordId && !!anonymousId`): the
  // supplied-kinds test IS that key-shape test over the same locals (PRD 06 L2).
  const suppliedKinds = keys.map((k) => k.kind);
  const clamped =
    policy.allowMerge === "anonymous-only" &&
    suppliedKinds.length === 1 &&
    suppliedKinds[0] === "anonymous";

  const patch = contactProperties ?? {};
  const hasPatch = Object.keys(patch).length > 0;

  const committed = await db.transaction(async (tx) => {
    // (−1) ENGINE-INTERNAL PROVENANCE PIN. A uuid-shaped `contactId` from a
    // trusted internal re-emit pins resolution to that exact row (no value-key
    // probe, no mint), so a contact's own canonical key round-tripping back as a
    // `userId` folds into it instead of minting a phantom `external_id` twin.
    // Gated on `!clamped` (mutually exclusive with the publishable
    // clamp — a clamped pk_ write can never carry provenance) so it is never an
    // attacker-reachable path. Runs BEFORE the value-key advisory locks: the pin
    // serializes on the concrete row PK via `FOR UPDATE`, not on value locks.
    if (contactId && UUID_REGEX.test(contactId) && !clamped) {
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
      // --- ARM: refuse (D1) --- Observation is not identity: a caller that
      // opted out of minting gets `id: null` and the key it supplied, and NO
      // `contacts` row is written. The event still stores under this key
      // (D2) — and a later identify ADOPTS that history, so nothing is
      // orphaned by the refusal. TWO arms do that adoption, and which one runs
      // depends on whether a contact already exists by the time the anon id
      // arrives: the create arm below when the identify supplies both keys at
      // once, and `fillInLink` when identity was folded server-side first (the
      // shape the docs sign-in produces). Both are gated on the anon key not
      // naming another contact.
      if (policy.create !== "on-miss") {
        if (refuseWithKey === undefined) {
          // Unreachable: `refuse-on-miss` enters only through
          // `resolveContactNoCreate`, whose D8 precondition already threw when
          // neither `userId` nor `anonymousId` was supplied. Narrows without a
          // cast.
          throw new Error(
            "refuse-on-miss resolve without a derivable refusal key",
          );
        }
        return {
          id: null,
          resolvedKey: refuseWithKey,
          created: false,
          linked: false,
          merged: false,
        };
      }
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

      // PRD 02 dual-write: the create arm historically wrote ZERO alias rows.
      await ensureIdentityAliases(tx, createdRow);

      // HISTORY ADOPTION (D2). Once observation stops minting a row, a later
      // identify no longer finds an anon contact to fill-in-link — it lands
      // HERE, in the create arm. Everything already keyed on the anon id
      // (user_events, journey_states, bucket_memberships, email_sends,
      // email_preferences — incl. an unsubscribe) would otherwise be silently
      // orphaned under a key no contact owns.
      //
      // Adoption is self-gating (T9): `adoptOrphanHistory` touches only
      // `contact_id IS NULL` rows, so a value that is some other live
      // contact's key cannot surrender their history — those rows carry their
      // owner's id. `keysAnotherContact` therefore no longer gates adoption;
      // it survives below ONLY to gate the `mergedKeys` REPORT — a foreign
      // anon id must never enter the analytics stitch.
      const createdKey = contactKey(createdRow);
      // History written under the row's OWN key BEFORE it existed. Not a
      // merge: no key is absorbed, so it reports nothing in `mergedKeys` and
      // fires no analytics stitch.
      await adoptOrphanHistory(tx, createdKey, createdRow);
      let mergedKeys: string[] | undefined;
      if (anonymousId && anonymousId !== createdKey) {
        // The anon key was just superseded as canonical — stamp its orphans.
        // Only ever FROM `anonymousId`: an email/discord-shaped key is never
        // canonical, so it never keyed history.
        await adoptOrphanHistory(tx, anonymousId, createdRow);
        if (!(await keysAnotherContact(tx, anonymousId, createdRow.id))) {
          // §5.3 emission point 2 (canonical-key flip): report the absorbed
          // anon key so `ingestEvent` still fires `mergeAnalyticsIdentities({
          // reason: "key_flip" })` — otherwise the DB history is adopted but
          // the PostHog anon→known stitch stays broken. Safe to alias by
          // construction (an anonymous key never identified a person — MF-2).
          mergedKeys = [anonymousId];
        }
      }

      return {
        id: createdRow.id,
        resolvedKey: createdKey,
        created: true,
        linked: false,
        merged: false,
        mergedKeys,
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
      if (clamped && (single.externalId || single.email)) {
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
    //
    // UNREACHABLE BY CONSTRUCTION (PRD 06 T1 mutation-gate note) — do not
    // burn time hunting a test that can kill this guard; none can. `clamped`
    // requires `suppliedKinds` to be exactly `["anonymous"]`, so `keys` holds
    // ONE entry, `findByKey` returns at most ONE row per key, and
    // `candidates.length <= 1` — but this arm runs only when
    // `candidates.length >= 2`. The same argument means PRD 06 T2's planned
    // {anon-only key × two-colliding-rows} equivalence cell cannot actually
    // drive a collide-MERGE — an anon-only fixture lands in the create or
    // fill-in-link arm no matter what rows are seeded; don't be confused when
    // that cell never reaches here. The guard stays anyway: it is a behaviour
    // of record (removing it is not a refactor) and it becomes load-bearing
    // the moment key construction lets a clamped resolve supply a second key.
    if (clamped) {
      throw new PublishableAnonymousMergeError();
    }
    const { id, resolvedKey, mergedKeys, mergedIdentifiedKeys, linkUnlinks } =
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
      linkUnlinks,
    };
  });

  // One widening step: the callback's inferred return is a UNION of per-arm
  // object literals and only the merge arm declares `linkUnlinks`, so the
  // field is unreadable off the raw union. This is the declared result type
  // the old `return db.transaction(...)` was checked against — no cast, no
  // behaviour change.
  const resolved: ResolveContactSharedResult = committed;

  // THE MERGE'S `account.unlinked` EMIT (PRD 08 T3), and the reason this
  // function `await`s its own transaction instead of returning it.
  //
  // `foldLinkedAccounts` produced these facts INSIDE the transaction above, so
  // it cannot emit them itself: a merge that rolled back after the fold must
  // never have announced an unlink that never happened. Here we are strictly
  // past the COMMIT — the transaction promise has resolved, so a rollback took
  // the `throw` path and never reached this line. This is the commit/intent
  // layer DECISIONS §8 names, and it is ONE owner for every call site of
  // `resolveOrCreateContact` / `resolveContactNoCreate`.
  //
  // Only the singleton-COLLISION soft-unlinks are here. The repoint that moves
  // the loser's surviving links to the survivor is deliberately silent — see
  // the note on step 4 of `foldLinkedAccounts`.
  if (resolved.linkUnlinks && resolved.linkUnlinks.length > 0) {
    emitAccountUnlinked(db, resolved.linkUnlinks);
    // THE JOURNEY PLANE, beside the outbound one (PRD 08 T5). TWO DIFFERENT
    // PLANES: `emitAccountUnlinked` writes a `webhook_deliveries` row for the
    // CUSTOMER'S subscriber; this writes `user_events` + pushes to Hatchet so
    // a journey can trigger on `account.unlinked`. Neither may be collapsed
    // into the other — see the header of `lib/account-link-ingest.ts`.
    //
    // Yes, this re-enters `ingestEvent`, which is what called this resolver.
    // It is bounded at one hop and cannot loop: `fact.owner.contactId` is the
    // LOSER row (soft-deleted by the merge just above), so the re-ingest takes
    // the provenance-pin branch, which follows the merge alias to the SURVIVOR
    // and returns without probing value keys — so it can neither merge again
    // nor produce a second `linkUnlinks`. It is also fire-and-forget and
    // strictly post-commit, so it cannot slow or fail the resolve.
    for (const fact of resolved.linkUnlinks) {
      ingestAccountUnlinked(db, fact);
    }
  }

  return resolved;
}

/**
 * THE resolver (D1) — create-on-miss. A thin entry point over
 * {@link resolveContactShared} (see there for the create / fill-in-link /
 * collide-MERGE arms and the INSERT-race lock strategy). Behavior and published
 * type are unchanged by the extraction: `id` is a plain `string`, never `null`,
 * because this entry point never passes `refuseCreateWithKey` — the refusal arm
 * is unreachable from here. That matters concretely (D3): three sites annotate
 * on `Awaited<ReturnType<typeof resolveOrCreateContact>>`, one of them the
 * published `IdentityService.linkContact`, so widening `id` here would ripple
 * into the semver surface. Callers that want the refusal reach for
 * {@link resolveContactNoCreate} instead.
 */
export async function resolveOrCreateContact(
  opts: ResolveContactOptions,
): Promise<{
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
  /**
   * PRD 04: the `linked_accounts` soft-unlinks a collide-MERGE performed
   * (loser's live singleton link lost the arbitration — see
   * {@link MergedLinkUnlink}). PRD 08 emits one `account.unlinked` per entry
   * post-commit. Absent when the resolve unlinked nothing.
   */
  linkUnlinks?: MergedLinkUnlink[];
}> {
  // PRD 06: this entry point is create-on-miss BY CONTRACT — honouring a
  // refuse-on-miss policy here would make the refusal arm reachable and force
  // the published `id: string` to widen (D3). Reject loudly rather than guess.
  if (opts.policy && opts.policy.create !== "on-miss") {
    throw new Error(
      "resolveOrCreateContact is create-on-miss by contract (D3: `id` is " +
        'never null) — use resolveContactNoCreate for `create: "refuse-on-miss"`',
    );
  }
  const resolved = await resolveContactShared(opts);
  if (resolved.id === null) {
    // Unreachable: `refuseCreateWithKey` is never set on this path (and a
    // refuse-on-miss policy is rejected above), so every arm either resolves a
    // row or inserts one. Narrows `id` without a cast.
    throw new Error("resolveOrCreateContact resolved to no contact");
  }
  return { ...resolved, id: resolved.id };
}

/**
 * THE resolver's refuse-on-miss sibling (D1/D3). Same implementation, same
 * fill-in-link and collide-MERGE behavior — the ONLY difference is that a miss
 * returns `{ id: null }` instead of minting a `contacts` row. Use it wherever a
 * write is pure OBSERVATION (an unidentified browser, a chat-gateway presence
 * ping): seeing traffic is not grounds for a CRM row, and the event still
 * stores under `resolvedKey` (D2), so journey routing, exit checks and
 * analytics mirroring are untouched.
 *
 * PRECONDITION (D8) — THROWS unless the highest-precedence supplied key is
 * `userId` or `anonymousId`. The canonical key is
 * `contactKey = external_id ?? anonymous_id ?? id`, so `email` and `discord_id`
 * are NEVER canonical: for an email-only / discord-only call today's code keys
 * history on the freshly-minted row's uuid, which a refusal cannot reproduce and
 * for which no repoint path back exists. Refusal there would strand history, so
 * the shape is rejected as a misuse rather than silently mis-keyed.
 *
 * The refusal key is exactly what the create arm would have made canonical for
 * the two permitted shapes (`userId ?? anonymousId`), so a refused call and a
 * creating one agree on `resolvedKey` byte-for-byte.
 */
export async function resolveContactNoCreate(
  opts: ResolveContactOptions,
): Promise<{
  /** `null` ⇒ REFUSED: no live contact owned any supplied key, and none was
   * minted. Otherwise the resolved (linked/merged) contact's id. */
  id: string | null;
  /** As {@link resolveOrCreateContact}; on a refusal, the supplied key. */
  resolvedKey: string;
  /** Always false — this entry point never mints. */
  created: false;
  linked: boolean;
  merged: boolean;
  mergedKeys?: string[];
  mergedIdentifiedKeys?: string[];
  /** As {@link resolveOrCreateContact} (PRD 04). */
  linkUnlinks?: MergedLinkUnlink[];
}> {
  // Mirror the shared body's normalization so the precondition reads the same
  // keys resolution will (a whitespace-only `userId` is not a supplied key).
  const userId = opts.userId?.trim() || undefined;
  const anonymousId = opts.anonymousId?.trim() || undefined;
  const refuseCreateWithKey = userId ?? anonymousId;
  if (!refuseCreateWithKey) {
    throw new Error(
      "resolveContactNoCreate requires userId or anonymousId as the " +
        "highest-precedence key (D8): email/discordId are never canonical, so " +
        "a refusal there would key history on a row uuid that was never minted",
    );
  }

  // PRD 06: with a declared policy the legacy internal channel stays UNSET —
  // the shared body re-derives the identical `userId ?? anonymousId` refusal
  // key from the same normalized locals (validated present above), so `policy`
  // and `refuseCreateWithKey` can never collide.
  if (opts.policy) {
    if (opts.policy.create !== "refuse-on-miss") {
      throw new Error(
        "resolveContactNoCreate never mints (`created` is pinned false) — " +
          'its policy must declare `create: "refuse-on-miss"`; use ' +
          "resolveOrCreateContact for create-on-miss",
      );
    }
    const resolved = await resolveContactShared(opts);
    return { ...resolved, created: false };
  }

  const resolved = await resolveContactShared({ ...opts, refuseCreateWithKey });
  // Structurally always false (the create arm is refused above); pinned in the
  // type so callers can't branch on a create this entry point cannot perform.
  return { ...resolved, created: false };
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
 * Single matching row: claim every supplied identity key the row does not
 * already hold (column when free — the legacy dual-write — identity row
 * ALWAYS), apply the property patch, then repoint/adopt history where the
 * claims require it.
 *
 * PRD 03 shape — the arm PLANS, {@link claimIdentityKey} EXECUTES: one ordered
 * pass over the supplied keys replaces the old per-kind attach branches, whose
 * arm-local side effects are how the if-arm shipped without the foreign-key
 * gate. "The column is taken" is a non-event now: a second/third value per
 * kind is just another identity row, for every kind alike.
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
  /** Shape parity with {@link mergeContacts} (PRD 04); a fill-in-link never
   * touches `linked_accounts`, so this arm never sets it. */
  linkUnlinks?: MergedLinkUnlink[];
}> {
  const set: Record<string, unknown> = {
    lastSeenAt: new Date(),
    updatedAt: new Date(),
  };

  // The contact's canonical string key BEFORE this fill (external_id ??
  // anonymous_id ?? id). Attaching an external_id (or anonymous_id where none
  // existed) flips this key — its existing string-keyed history must follow
  // (risk 1), else entry-limit guards / history checks query under the new key
  // and silently miss the pre-link history.
  const oldKey = contactKey(row);
  let nextExternalId = row.externalId;
  let nextAnonymousId = row.anonymousId;

  // The supplied keys, in the resolver's precedence order. `current` is the
  // column value the row holds for that kind today; `column` names the legacy
  // dual-write slot (retired in PRD 07). Note discord_id / email are attachable
  // resolvable keys but NEVER the canonical key (external_id ?? anonymous_id ??
  // id) — gaining either never flips the canonical key, so neither touches
  // nextExternalId/nextAnonymousId below.
  const supplied: {
    kind: Kind;
    value: string;
    current: string | null;
    column: "externalId" | "email" | "anonymousId" | "discordId";
  }[] = [];
  if (ctx.userId)
    supplied.push({
      kind: "external",
      value: ctx.userId,
      current: row.externalId,
      column: "externalId",
    });
  if (ctx.email)
    supplied.push({
      kind: "email",
      value: ctx.email,
      current: row.email,
      column: "email",
    });
  if (ctx.anonymousId)
    supplied.push({
      kind: "anonymous",
      value: ctx.anonymousId,
      current: row.anonymousId,
      column: "anonymousId",
    });
  if (ctx.discordId)
    supplied.push({
      kind: "discord",
      value: ctx.discordId,
      current: row.discordId,
      column: "discordId",
    });

  // Keys THIS call was first to claim — the adoption/report signal. Refused
  // (foreign) keys never enter it; repeat claims conflict on the unique index
  // and never re-enter it. A person browses from more than one device, and
  // `contacts.anonymous_id` holds exactly one — `contact_aliases` is the
  // multi-key table, and `findByKey` reads it first, so any claimed value
  // resolves back here once recorded.
  const foreignMemo = new Map<string, boolean>();
  const claimed: ResolveKey[] = [];

  for (const s of supplied) {
    // Hottest path there is (every repeat page view from a known device): the
    // value is already the row's column value — nothing to claim, no queries.
    if (s.value === s.current) continue;

    const outcome = await claimIdentityKey(
      tx,
      row,
      { kind: s.kind, value: s.value },
      foreignMemo,
    );
    // A refused (foreign-canonical-key) claim skips EVERYTHING for this key:
    // no column write (an external write would flip the canonical key and
    // repoint the claimant's history INTO a string someone else's rows key
    // on), no identity row, no adoption, no mergedKeys report.
    if (outcome === "refused") continue;

    if (s.current == null) {
      // Legacy dual-write: the column when it happens to be free (PRD 07
      // retires the columns; writing them keeps every column-only reader
      // working until then).
      set[s.column] = s.value;
      if (s.kind === "external") nextExternalId = s.value;
      if (s.kind === "anonymous") nextAnonymousId = s.value;
    }
    if (outcome === "claimed") claimed.push({ kind: s.kind, value: s.value });
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

  // Adopt the contact's own orphan history (stamp-only since T9; nothing
  // rewrites the string key anymore). The updated row carries the post-fill
  // keys the fold scopes resolve ownership with.
  const newKey = nextExternalId ?? nextAnonymousId ?? row.id;
  // §5.3 emission point 2 (canonical-key flip): when the key flips, the OLD key
  // is folded into the NEW one. MF-3 gate — only emit a merge when `oldKey` was
  // an anonymous/uuid key (never an `external_id` being superseded; that is the
  // twin case, OQ-1). In practice a flip in fillInLink only fires when the row
  // had NO external_id (attaching one never happens to an already-external row),
  // so `oldKey` is structurally always anon/uuid here — the explicit gate guards
  // the invariant regardless.
  const updatedRow: ContactRow = {
    ...row,
    externalId: nextExternalId,
    anonymousId: nextAnonymousId,
    email: (set.email as string | undefined) ?? row.email,
    // Post-fill discord id: not part of the canonical key, but the PRD 02
    // dual-write below records an alias per column the row NOW carries.
    discordId: (set.discordId as string | undefined) ?? row.discordId,
  };

  let mergedKeys: string[] | undefined;
  let mergedIdentifiedKeys: string[] | undefined;
  // T9: adoption is unconditional — with nothing keyed on the canonical key,
  // "did the key flip" no longer decides whether history is stamped. Orphans
  // under the pre-fill key are adopted either way (idempotent when there are
  // none); the flip test now gates only the analytics REPORT.
  await adoptOrphanHistory(tx, oldKey, updatedRow);
  if (newKey !== oldKey) {
    const oldKeyWasExternalId =
      row.externalId != null && oldKey === row.externalId;
    if (oldKeyWasExternalId) {
      mergedIdentifiedKeys = [oldKey];
    } else {
      mergedKeys = [oldKey];
    }
  }

  // ADOPT ORPHANED ANON HISTORY — the second-order effect of refusing to mint
  // on observation. When an anon id is newly claimed but does NOT become the
  // canonical key (the row already had an `external_id`), the flip test above is
  // false, so nothing above this moves the history keyed on that anon id.
  //
  // That is the docs sign-in order exactly: the server-side fold resolves
  // { email, userId } with no anon id and CREATES the row already carrying
  // `external_id`; the browser's `identify()` then arrives with the anon id and
  // lands here. Before observation-refusal shipped, a contact row existed for
  // the anon id and the collide-MERGE arm adopted its history; refusal removed
  // that row, and with it the only arm that did the adoption. Without this, a
  // visitor who browses anonymously and then registers keeps their contact but
  // loses every event, journey state, send and preference recorded before they
  // signed up.
  //
  // It also covers the SECOND-DEVICE shape, which the same refusal broke the
  // same way: the row's `anonymous_id` column is already taken by the first
  // device, so the id from a second one is claimed as an identity row above,
  // and its pre-sign-in history is adopted here.
  //
  // Adoption is ANONYMOUS-ONLY (claiming adds a resolution edge; adopting MOVES
  // rows — a second external/email/discord value never keyed this person's
  // history, so there is nothing to move; PRD 04 reunites externally-keyed rows
  // through the identity row instead). Foreign keys never reach this loop: the
  // claim path refused them before `claimed` was built. That refusal is the
  // ONLY thing standing between a caller and someone else's rows — this shape
  // carries a `userId`, so `restrictToAnonymous` is false by construction (it
  // requires `!userId`) and neither publishable clamp fires. A `userToken`
  // proves which account the caller is; it says nothing about which
  // `anonymousId` they may name, and a canonical key is a far weaker secret
  // than a browser-local id (it is frequently a sequential or public account
  // id). First-claim-only by construction (`claimed` is populated from the
  // insert's `returning()`), so a browser that identifies on every page load
  // cannot re-adopt or re-fire the analytics stitch — the re-stitch storm
  // guard, structural instead of remembered.
  for (const key of claimed) {
    if (key.kind !== "anonymous") continue;
    if (key.value === newKey || key.value === oldKey) continue;
    await adoptOrphanHistory(tx, key.value, updatedRow);
    // Reported so `mergeAnalyticsIdentities` still fires the anon→known stitch;
    // appended, since a key flip above may already have folded a uuid/anon key.
    mergedKeys = [...(mergedKeys ?? []), key.value];
  }

  // PRD 02 dual-write, AFTER the claim pass so newly-claimed keys keep their
  // `promote` provenance and only the row's pre-existing (pre-alias-era)
  // columns gain `resolve` rows. This is what backfills a hot contact whose
  // columns predate `contact_aliases`, without waiting for the offline job.
  await ensureIdentityAliases(tx, updatedRow);

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
  linkUnlinks?: MergedLinkUnlink[];
}> {
  const { survivor, losers } = pickSurvivor(candidates);
  const survivorKey = contactKey(survivor);

  // §5.3 emission point 1 (collide-MERGE) accumulators. MF-2: a loser's
  // anonymous/uuid key is SAFE to absorb (it never identified a PostHog person);
  // a loser's `external_id` is an already-identified person PostHog refuses to
  // merge on the safe path — it is recorded as the twin residual, NEVER aliased.
  const safeLoserKeys: string[] = [];
  const identifiedLoserKeys: string[] = [];
  // PRD 04: every `linked_accounts` soft-unlink the fold performs, returned so
  // PRD 08 can emit `account.unlinked` post-commit. Never emitted in here.
  const linkMutations: MergedLinkUnlink[] = [];

  for (const loser of losers) {
    // The id is the last-resort key for a loser that has neither external nor
    // anonymous id (its user_id rows were keyed on contacts.id).
    const loserStrKeys = [loser.externalId, loser.anonymousId, loser.id].filter(
      (k): k is string => Boolean(k),
    );

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

    // (ii) user_events `contact_id` stamp — the ADOPTION half only (NULL rows:
    // history the loser's keys accumulated before any contact existed). PRD 07
    // T7 deleted the paired `user_id` rewrite: the key stays frozen at its
    // write-time value and ownership rides the FK. Rows already owned by the
    // LOSER keep `loser.id` here and are re-pointed wholesale by (vi-b-hist)
    // below, which is the one statement that may overwrite a non-NULL owner.
    // Splitting it that way keeps a single rule in the fragment (never take a
    // row from another contact) and one explicit, auditable place where a
    // merge does.
    await tx
      .update(userEvents)
      .set({
        contactId: adoptedContactId(userEvents.contactId, survivor.id),
      })
      .where(inArray(userEvents.userId, loserStrKeys));

    // (iii) journey_states — exit the loser's duplicate active/waiting row when
    // the survivor already holds an active/waiting row in the same journey
    // (respect uq_user_journey_active), THEN rewrite user_id/user_email.
    await foldJourneyStates(tx, survivorKey, loserStrKeys, survivor, loser.id);

    // (iv) email_sends: `contact_id` stamp (NULL-guarded, as (ii)) + the
    // userEmail denorm. `user_id` frozen (PRD 07 T7); the address denorm still
    // updates because it feeds person-level send history, not identity.
    await tx
      .update(emailSends)
      .set({
        contactId: adoptedContactId(emailSends.contactId, survivor.id),
        ...(survivor.email ? { userEmail: survivor.email } : {}),
      })
      .where(inArray(emailSends.userId, loserStrKeys));

    // (v) bucket_memberships — soft-leave the loser's duplicate active
    // membership when the survivor already holds one in the same bucket (respect
    // uq_user_bucket_active, preserve survivor's dwell clock), THEN rewrite.
    await foldBucketMemberships(
      tx,
      survivorKey,
      loserStrKeys,
      survivor.id,
      loser.id,
    );

    // (vi) email_preferences FOLD (never blind-rewrite — risk 6).
    await foldEmailPreferences(
      tx,
      loserStrKeys,
      survivorKey,
      survivor.id,
      loser.id,
    );

    // (vi-b) deals + crm_links re-point: these carry contact_id uuid FKs
    // (not user keys), which the key rewrites above never touch. Without
    // this, the loser's open deal is orphaned on a soft-deleted row — the
    // survivor's next stage event/trigger would mint a SECOND deal (and a
    // duplicate deal.sold). Neither table has a unique index on contact_id,
    // so plain UPDATEs suffice.
    await tx
      .update(deals)
      .set({ contactId: survivor.id })
      .where(eq(deals.contactId, loser.id));
    await tx
      .update(crmLinks)
      .set({ contactId: survivor.id })
      .where(eq(crmLinks.contactId, loser.id));

    // (vi-b-hist) the five HISTORY tables' `contact_id` re-point (PRD 04 T3).
    // Same shape as the deals/crm_links repoints above: a uuid column the
    // key stamps above never touch.
    //
    // PRD 05 T3: `contact_id` IS now a unique-index column on three of these
    // five (migration 0071), so "plain UPDATEs suffice" is no longer true on its
    // own — it holds only because the folds above ran FIRST and already know
    // about `contact_id`. {@link foldScopes} makes each fold read the survivor's
    // occupancy AND the loser's rows by `user_id` OR `contact_id`, so by the
    // time these statements run, every loser row that would have duplicated a
    // survivor row inside a contact-scoped index has been exited, left or
    // deleted. That is the invariant these three statements depend on; widen a
    // fold's scope, never this.
    // Deliberately lands AHEAD of the dual-write that populates the column
    // (PRD 04 D9/D10): while every row is still NULL this is a pure no-op, and
    // the moment the dual-write starts, merges are already correct. Shipped in
    // the other order, every merge in between would strand history rows
    // pointing at a soft-deleted loser contact.
    //
    // It is also the OVERWRITE half of the stamps above: those touch only
    // rows nobody owned (the {@link adoptedContactId} NULL guard), so the
    // loser-OWNED rows arrive here still carrying `loser.id` and this is what
    // moves them. Between the two halves, every row the merge folds carries
    // the survivor's uuid while `user_id` stays frozen at its write-time
    // value (PRD 07 T7). Runs after the stamps rather than before because it
    // filters on `contact_id`, not `user_id`, and re-running the pair changes
    // nothing (`contact_id = loser.id` matches zero rows twice).
    await tx
      .update(userEvents)
      .set({ contactId: survivor.id })
      .where(eq(userEvents.contactId, loser.id));
    await tx
      .update(journeyStates)
      .set({ contactId: survivor.id })
      .where(eq(journeyStates.contactId, loser.id));
    await tx
      .update(bucketMemberships)
      .set({ contactId: survivor.id })
      .where(eq(bucketMemberships.contactId, loser.id));
    await tx
      .update(emailSends)
      .set({ contactId: survivor.id })
      .where(eq(emailSends.contactId, loser.id));
    await tx
      .update(emailPreferences)
      .set({ contactId: survivor.id })
      .where(eq(emailPreferences.contactId, loser.id));

    // (vi-c) group_memberships FOLD: another contact_id uuid FK the key
    // rewrites never touch. The loser is SOFT-deleted, so `onDelete: cascade`
    // never fires — without this the loser's memberships are stranded on a dead
    // row (the survivor's drawer shows "no groups", and the group's member
    // count/list disagree). uq(group_id, contact_id) forbids a blind rewrite
    // when BOTH already belong to the same group, so fold-then-rewrite.
    await foldGroupMemberships(tx, survivor.id, loser.id);

    // (vi-d) linked_accounts FOLD — the same stranding failure as (vi-c), with
    // an extra wrinkle: the singleton partial-unique index forbids a blind
    // repoint. See foldLinkedAccounts.
    linkMutations.push(
      ...(await foldLinkedAccounts(tx, survivor.id, loser.id)),
    );

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

  // The survivor as it stands AFTER the update above — what the claim step and
  // the PRD 02 dual-write below both key off.
  const postSurvivor: ContactRow = {
    ...survivor,
    externalId:
      (survivorSet.externalId as string | undefined) ?? survivor.externalId,
    email: (survivorSet.email as string | undefined) ?? survivor.email,
    anonymousId:
      (survivorSet.anonymousId as string | undefined) ?? survivor.anonymousId,
    discordId:
      (survivorSet.discordId as string | undefined) ?? survivor.discordId,
  };

  // PRD 03 T4 — claim CALL-supplied keys the survivor's columns could not
  // hold. Loser-held keys already survive as identity rows via
  // `recordMergeAliases`; the only drop left was a ctx key when the survivor's
  // column was already occupied — each `if (!survivor.<column>)` block above
  // picks one value and used to discard the rest. Runs AFTER the loser
  // soft-delete (the partial-unique live indexes are already free — the same
  // ordering the survivorSet copy depends on) and AFTER the survivor update.
  // Same gate as fill-in-link: an external/anonymous value that is another
  // live contact's canonical key is refused, not aliased — a merge arm reached
  // with a foreign key (one the candidate probes never matched) must not mint
  // a resolution edge to someone else's person. NO adoption here: every
  // absorbed candidate key's history was already folded by the loser rewrites
  // above; a claimed second value never keyed history at all.
  {
    const foreignMemo = new Map<string, boolean>();
    const unheld: ResolveKey[] = [];
    if (ctx.userId && ctx.userId !== postSurvivor.externalId)
      unheld.push({ kind: "external", value: ctx.userId });
    if (ctx.email && ctx.email !== postSurvivor.email)
      unheld.push({ kind: "email", value: ctx.email });
    if (ctx.anonymousId && ctx.anonymousId !== postSurvivor.anonymousId)
      unheld.push({ kind: "anonymous", value: ctx.anonymousId });
    if (ctx.discordId && ctx.discordId !== postSurvivor.discordId)
      unheld.push({ kind: "discord", value: ctx.discordId });
    for (const key of unheld) {
      await claimIdentityKey(tx, postSurvivor, key, foreignMemo);
    }
  }

  // PRD 02 dual-write on the POST-merge survivor row: a `resolve` alias per
  // identity column it now carries. Runs AFTER `recordMergeAliases` (inside the
  // loser loop above), so the loser keys' `merge` provenance wins the conflict
  // and only the survivor's pre-alias-era keys gain rows here.
  await ensureIdentityAliases(tx, postSurvivor);

  // If the survivor's canonical key flipped (it had no external_id/anonymous_id
  // and the merge promoted one from the call/loser), stamp any orphans still
  // sitting under the OLD survivor key (risk 1). The loser folds above already
  // stamped everything they routed, so this reaches only rows that predate the
  // survivor's own contact_id era.
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
    await adoptOrphanHistory(tx, survivorKey, updatedSurvivor);
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
    linkUnlinks: linkMutations.length > 0 ? linkMutations : undefined,
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
 * Fix: build the survivor's occupancy and route each loser row to exit / delete /
 * rewrite. For a LIVE collision, EXIT the loser's row first (preserve the
 * survivor's live run) so the rewrite lands an 'exited' (out-of-predicate) row.
 * For a TERMINAL collision, DELETE the loser's duplicate — no longer REQUIRED by
 * the constraint (terminal rows are outside the predicate), but kept as hygiene
 * so the survivor doesn't carry two identical terminal rows (which would inflate
 * the count()-based ctx.history.journey.entryCount). Rewrite only the
 * non-colliding remainder onto the survivor key (+ survivor email). Re-check
 * 'exited' occupancy after exiting so a just-exited loser row that would now
 * duplicate a pre-existing survivor 'exited' row is dropped rather than rewritten.
 *
 * Occupancy is asked BOTH ways (see {@link foldScopes}), and LIVE occupancy is
 * keyed on the journey ALONE: both unique indexes say `status IN ('active',
 * 'waiting')`, i.e. the two live statuses share ONE slot, so a survivor 'active'
 * row and a loser 'waiting' row in the same journey collide even though their
 * (journey|status) pairs differ.
 */
async function foldJourneyStates(
  tx: Tx,
  survivorKey: string,
  loserKeys: string[],
  survivor: ContactRow,
  loserId?: string,
  opts?: FoldWriteOpts,
): Promise<void> {
  const ACTIVE = new Set<string>(["active", "waiting"]);
  const { isLoser, isSurvivor } = foldScopes({
    userIdCol: journeyStates.userId,
    contactIdCol: journeyStates.contactId,
    survivorKey,
    survivorId: survivor.id,
    loserKeys,
    loserId,
    orphansOnly: opts?.stampOnly,
  });

  const survivorRows = await tx
    .select({
      journeyId: journeyStates.journeyId,
      status: journeyStates.status,
    })
    .from(journeyStates)
    .where(and(isSurvivor, isNull(journeyStates.deletedAt)));

  // Both sets are mutated as loser rows are routed, so two loser rows from
  // different keys (3-way merge) can't collide with each other either.
  const live = new Set(
    survivorRows.filter((s) => ACTIVE.has(s.status)).map((s) => s.journeyId),
  );
  const slots = new Set(survivorRows.map((s) => `${s.journeyId}|${s.status}`));

  const loserRows = await tx
    .select({
      id: journeyStates.id,
      journeyId: journeyStates.journeyId,
      status: journeyStates.status,
    })
    .from(journeyStates)
    .where(and(isLoser, isNull(journeyStates.deletedAt)));

  const idsToExit: string[] = [];
  const idsToDelete: string[] = [];
  const idsToRewrite: string[] = [];

  for (const l of loserRows) {
    const slot = `${l.journeyId}|${l.status}`;
    if (ACTIVE.has(l.status)) {
      if (!live.has(l.journeyId)) {
        // The one live slot for this journey is free — claim it.
        idsToRewrite.push(l.id);
        live.add(l.journeyId);
        slots.add(slot);
        continue;
      }
      // Survivor (or a prior loser) already holds the live slot — exit the
      // loser's row so the live run continues. Only do so if the resulting
      // 'exited' slot is itself free; otherwise drop it.
      const exitedSlot = `${l.journeyId}|exited`;
      if (slots.has(exitedSlot)) {
        idsToDelete.push(l.id);
      } else {
        idsToExit.push(l.id);
        slots.add(exitedSlot);
      }
    } else if (slots.has(slot)) {
      // Terminal collision (both completed/failed/exited the same journey) —
      // the survivor already records this state; drop the loser duplicate.
      idsToDelete.push(l.id);
    } else {
      idsToRewrite.push(l.id);
      slots.add(slot);
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

  // Route both the originally non-colliding rows AND the just-exited rows to
  // the survivor (the exited rows now sit in claimed-free 'exited' slots).
  // Stamp mode (adoption, PRD 05 T9): one column — every matched row is an
  // orphan (`orphansOnly` scope), so a plain stamp cannot re-parent anything.
  // The string key and denormalized email stay frozen at write-time values.
  const rewriteIds = [...idsToRewrite, ...idsToExit];
  if (rewriteIds.length > 0) {
    await tx
      .update(journeyStates)
      .set(
        opts?.stampOnly
          ? { contactId: survivor.id, updatedAt: new Date() }
          : {
              // PRD 07 T7: `user_id` is FROZEN in merge mode too — ownership
              // moves on the FK (NULL-guarded here; loser-owned rows re-point
              // in (vi-b-hist)). The email denorm still updates: it is the
              // live send address for a re-pointed run, not an identity key.
              contactId: adoptedContactId(journeyStates.contactId, survivor.id),
              ...(survivor.email ? { userEmail: survivor.email } : {}),
              updatedAt: new Date(),
            },
      )
      .where(inArray(journeyStates.id, rewriteIds));
  }
}

/**
 * bucket_memberships fold: if the survivor already holds an ACTIVE membership in
 * a bucket where a loser key also holds one, soft-LEAVE the loser's row first
 * (uq_user_bucket_active forbids two active rows for the same (user, bucket);
 * preserve the survivor's dwell clock), then rewrite the rest onto the survivor.
 *
 * `survivorId` is the absorbing contact's uuid — the soft-left rows are rewritten
 * by the same statement as the rest, so both halves of a folded pair leave here
 * carrying it (see {@link adoptedContactId} for the NULL guard).
 */
async function foldBucketMemberships(
  tx: Tx,
  survivorKey: string,
  loserKeys: string[],
  survivorId: string,
  loserId?: string,
  opts?: FoldWriteOpts,
): Promise<void> {
  const { isLoser, isSurvivor } = foldScopes({
    userIdCol: bucketMemberships.userId,
    contactIdCol: bucketMemberships.contactId,
    survivorKey,
    survivorId,
    loserKeys,
    loserId,
    orphansOnly: opts?.stampOnly,
  });

  const survivorActive = await tx
    .select({ bucketId: bucketMemberships.bucketId })
    .from(bucketMemberships)
    .where(
      and(
        isSurvivor,
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
        isLoser,
        eq(bucketMemberships.status, "active"),
        isNull(bucketMemberships.deletedAt),
      ),
    );

  // Claim as we go, so two loser rows active in the SAME bucket (3-way merge)
  // route the second to 'left' instead of both rewriting onto the survivor.
  const idsToLeave: string[] = [];
  for (const l of loserActive) {
    if (occupied.has(l.bucketId)) idsToLeave.push(l.id);
    else occupied.add(l.bucketId);
  }

  if (idsToLeave.length > 0) {
    await tx
      .update(bucketMemberships)
      .set({ status: "left", leftAt: new Date(), updatedAt: new Date() })
      .where(inArray(bucketMemberships.id, idsToLeave));
  }

  await tx
    .update(bucketMemberships)
    .set(
      opts?.stampOnly
        ? { contactId: survivorId, updatedAt: new Date() }
        : {
            // PRD 07 T7: `user_id` frozen in merge mode (see foldJourneyStates).
            contactId: adoptedContactId(
              bucketMemberships.contactId,
              survivorId,
            ),
            updatedAt: new Date(),
          },
    )
    .where(isLoser);
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
 * linked_accounts FOLD (vi-d, PRD 04 T2).
 * `linked_accounts_contact_provider_singleton_idx` is a PARTIAL unique index
 * on (contact_id, provider) WHERE unlinked_at IS NULL AND singleton, so a
 * blind repoint raises 23505 whenever survivor and loser both hold a live
 * singleton link for the same provider. Resolution: the survivor's row stays
 * (the survivor is what `pickSurvivor` considers primary, consistent with
 * every other fold), the loser's is SOFT-unlinked with reason "relinked"
 * through the store's versioning helper (never raw SQL — an unlink whose
 * version does not advance is discarded forever by the consumer's monotonic
 * guard, DECISIONS §5.3), and everything else repoints.
 *
 * `multiple: true` links (singleton = false) and already-unlinked history rows
 * need no arbitration: they are outside the partial index, so they just move.
 *
 * Known lock-order hazard, stated rather than hidden (PRD 04): the merge
 * transaction already holds contact-key advisory locks (taken at the top of
 * the resolve tx) and only NOW takes pair locks; the store takes pair locks
 * and then touches `linked_accounts` rows belonging to contacts. The two
 * never take the SAME two advisory locks in opposite orders, so there is no
 * advisory-lock cycle, but a ROW-lock cycle between a merge and a concurrent
 * link on the same rows is possible in principle — Postgres detects it and
 * aborts one side with 40P01, which surfaces as a failed resolve/link the
 * caller retries. Mitigation, not elimination: this fold runs as LATE as
 * possible in the merge (immediately before `recordMergeAliases`) so the
 * window is a few statements wide. Do not attempt a global lock ordering
 * across the two subsystems.
 */
async function foldLinkedAccounts(
  tx: Tx,
  survivorId: string,
  loserId: string,
): Promise<MergedLinkUnlink[]> {
  const facts: MergedLinkUnlink[] = [];

  // 1. The survivor's occupied singleton providers.
  const survivorSingletons = await tx
    .select({ provider: linkedAccounts.provider })
    .from(linkedAccounts)
    .where(
      and(
        eq(linkedAccounts.contactId, survivorId),
        isNull(linkedAccounts.unlinkedAt),
        eq(linkedAccounts.singleton, true),
      ),
    );
  const occupied = survivorSingletons.map((r) => r.provider);

  if (occupied.length > 0) {
    // 2. The collisions: the loser's live singleton rows for those providers.
    const collisions = await tx
      .select({
        id: linkedAccounts.id,
        provider: linkedAccounts.provider,
        providerUserId: linkedAccounts.providerUserId,
      })
      .from(linkedAccounts)
      .where(
        and(
          eq(linkedAccounts.contactId, loserId),
          isNull(linkedAccounts.unlinkedAt),
          eq(linkedAccounts.singleton, true),
          inArray(linkedAccounts.provider, occupied),
        ),
      );

    // 3. Soft-unlink each collision at that pair's OWN next version, through
    // the store (PRD 03's tx-scoped entry point — `contacts.ts` never writes
    // a version).
    for (const row of collisions) {
      const outcome = await unlinkAccountInTx(tx, {
        rowId: row.id,
        provider: row.provider,
        providerUserId: row.providerUserId,
        reason: "relinked",
      });
      // The store's result is a UNION, not a bare success: a `not_found`
      // means the row went stale between our read and the pair lock
      // (unlinked/relinked by a concurrent commit) — nothing was mutated, so
      // recording a fact here would make PRD 08 emit a phantom
      // `account.unlinked`. Skip it; step 4 still repoints whatever remains.
      if (outcome.status !== "unlinked") continue;
      facts.push({
        provider: row.provider,
        providerUserId: row.providerUserId,
        version: outcome.version,
        contactId: loserId,
        reason: "relinked",
        // The `unlinked` arm the narrowing above just proved (the join to
        // `contacts` the store did under the pair lock). Copied, never
        // re-read: PRD 08's payload needs `userId`/`email`, and a second
        // lookup at emit time is no longer the state that committed.
        owner: outcome.owner,
      });
    }
  }

  // 4. Repoint EVERYTHING remaining — live, historical, and the rows step 3
  // just unlinked (an unlinked row is outside every partial index, so it
  // moves without conflict; leaving it behind would strand history on the
  // soft-deleted loser). A version-free ownership repoint, not a state
  // transition: version/linked_at/method/tokens are preserved.
  //
  // DELIBERATELY NOT AN EMIT POINT (PRD 08). A reader looking for the
  // `account.unlinked` that step 3 produces will look here too: moving a link
  // to the merge's survivor is not a new identity fact, it allocates no
  // version, and emitting from here would double-report every merge. Step 3's
  // soft-unlink is the different thing that IS emitted — it really did end a
  // link, at its own new version — and even that emit does not happen here:
  // this whole function runs INSIDE the merge transaction, so the emit lives
  // post-commit in `resolveContactShared` (DECISIONS §8, commit/intent layer).
  await tx
    .update(linkedAccounts)
    .set({ contactId: survivorId, updatedAt: new Date() })
    .where(eq(linkedAccounts.contactId, loserId));

  return facts;
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
 *
 * This is the one fold whose SURVIVING row is not the row that moved — a
 * collision keeps the TARGET and deletes the loser — so `survivorId` is stamped
 * on both branches: onto the re-pointed row when the slot is free, and onto the
 * target as part of the fold write when it is not. Same NULL guard either way
 * (see {@link adoptedContactId}); the fold branch expresses it in TS because the
 * target row is already in hand.
 */
async function foldEmailPreferences(
  tx: Tx,
  loserKeys: string[],
  survivorKey: string,
  survivorId: string,
  loserId?: string,
  opts?: FoldWriteOpts,
): Promise<void> {
  if (loserKeys.length === 0) return;

  const { isLoser, isSurvivor } = foldScopes({
    userIdCol: emailPreferences.userId,
    contactIdCol: emailPreferences.contactId,
    survivorKey,
    survivorId,
    loserKeys,
    loserId,
    orphansOnly: opts?.stampOnly,
  });

  const loserPrefs = await tx.select().from(emailPreferences).where(isLoser);

  if (loserPrefs.length === 0) return;

  const earliest = (a: Date | null, b: Date | null): Date | null => {
    if (!a) return b;
    if (!b) return a;
    return a < b ? a : b;
  };

  for (const lp of loserPrefs) {
    // Re-read the CURRENT target row for this address — it may be the original
    // survivor pref, a survivor row adoption stamped under a STALE key, a prior
    // loser's just-folded pref, or absent. A stamped row is preferred when both
    // exist: it is the row the contact-scoped read resolves, and the row whose
    // uniqueness a re-point would violate.
    const targetRows = await tx
      .select()
      .from(emailPreferences)
      .where(and(isSurvivor, eq(emailPreferences.email, lp.email)))
      .orderBy(sql`${emailPreferences.contactId} IS NULL`)
      .limit(1);
    const target = targetRows[0];

    if (!target) {
      // The slot is free on BOTH keys. Both modes stamp ownership only (PRD 07
      // T7: `user_id` frozen in merge mode too); merge mode NULL-guards the
      // stamp, stamp mode's rows are orphans by scope so a plain stamp is safe.
      await tx
        .update(emailPreferences)
        .set(
          opts?.stampOnly
            ? { contactId: survivorId, updatedAt: new Date() }
            : {
                contactId: adoptedContactId(
                  emailPreferences.contactId,
                  survivorId,
                ),
                updatedAt: new Date(),
              },
        )
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
        contactId: target.contactId ?? survivorId,
        updatedAt: new Date(),
      })
      .where(eq(emailPreferences.id, target.id));

    // The loser row would collide with the target on (survivorKey, email) if
    // re-pointed — its data is folded in, so drop it.
    await tx.delete(emailPreferences).where(eq(emailPreferences.id, lp.id));
  }
}

/**
 * Adopt ORPHAN history sitting under `fromKey` onto its owning contact — the
 * D4 statement, made permanent by PRD 05 T9: `UPDATE <t> SET contact_id = :id
 * WHERE user_id = :fromKey AND contact_id IS NULL`, on five tables. One
 * column. The string key is never rewritten again; reads follow `contact_id`
 * (T4-T8), and D9 keeps writing `user_id` on every insert, so history stays a
 * frozen record of the key it happened under.
 *
 * This replaced two functions:
 *  - `repointOwnHistory`, which rewrote `user_id` from the old canonical key
 *    to the new one on a key flip (with three dedupe folds against the
 *    string-scoped unique indexes), and
 *  - `adoptOwnKeyHistory`, which stamped history already sitting under a
 *    brand-new contact's OWN key.
 * The "did the canonical key flip" test that distinguished them is meaningless
 * when nothing is keyed on the canonical key, so both call shapes are one
 * function now: name the key, stamp its orphans.
 *
 * The `contact_id IS NULL` predicate is the anti-theft guard (D6): a row
 * another contact owns already carries that owner's id and can never match.
 * `keysAnotherContact` no longer gates adoption — it survives only to gate
 * the `mergedKeys` REPORT (the analytics stitch must never alias a foreign
 * key) and the attach path inside `claimIdentityKey`.
 *
 * The folds still run, re-expressed on the contact scope (D4/D5): the
 * adopting contact may ALREADY own a live row for the same journey/bucket (or
 * a pref row for the same address), and a bare stamp would mint a second row
 * satisfying `uq_contact_journey_active` / `uq_contact_bucket_active` /
 * `email_preferences_contact_email_idx` — a 23505 inside the resolve
 * transaction. Same routing as the merge fold (exit / soft-leave / dedupe /
 * pref-fold), stamp-only writes.
 *
 * Idempotent: a second run finds `contact_id` already set and matches nothing.
 */
async function adoptOrphanHistory(
  tx: Tx,
  fromKey: string,
  row: ContactRow,
): Promise<void> {
  const ownKey = contactKey(row);

  // user_events + email_sends: no unique constraint involved — plain stamps.
  await tx
    .update(userEvents)
    .set({ contactId: row.id })
    .where(and(eq(userEvents.userId, fromKey), isNull(userEvents.contactId)));
  await tx
    .update(emailSends)
    .set({ contactId: row.id })
    .where(and(eq(emailSends.userId, fromKey), isNull(emailSends.contactId)));

  // journey_states / bucket_memberships / email_preferences: stamp through
  // the folds so a collision with a row the contact already owns is routed
  // (exited / left / folded) instead of violating the contact-scoped index.
  await foldJourneyStates(tx, ownKey, [fromKey], row, undefined, {
    stampOnly: true,
  });
  await foldBucketMemberships(tx, ownKey, [fromKey], row.id, undefined, {
    stampOnly: true,
  });
  await foldEmailPreferences(tx, [fromKey], ownKey, row.id, undefined, {
    stampOnly: true,
  });

  // linked_accounts is deliberately ABSENT here, and that is not an omission.
  // This function stamps rows that sat under a text key with NO owner
  // (`WHERE user_id = :fromKey AND contact_id IS NULL`). `linked_accounts` has
  // no `user_id` column and its `contact_id` is NOT NULL: a link row can only
  // be created from a callback where the contact is already bound (DECISIONS
  // §7), so an orphan link row is unrepresentable. The merge path DOES carry
  // links — see foldLinkedAccounts. Do not "fix" this by adding a statement;
  // add a test instead if you doubt it.
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

/**
 * PRD 02 T2 — the identity-table dual-write. Ensures a `contact_aliases` row
 * exists for EVERY identity column the contact carries after a resolve (create /
 * fill-in-link / collide-merge survivor). Runs inside the resolver transaction
 * on the hottest write path in the engine, so it is shaped for the steady
 * state:
 *
 *   1. ONE batched SELECT over the row's `(kind, value)` pairs (≤4 rows via the
 *      unique index). On a repeat resolve every pair already exists and this is
 *      the ONLY statement — no insert, no conflict churn, no `updated_at` writes.
 *   2. ONE batched INSERT for the missing pairs only, `onConflictDoNothing` on
 *      `(alias_kind, alias_value)` as the race guard (concurrent resolvers for
 *      the same key already serialize on the advisory locks; a cross-key race
 *      lands here and is silently deduped). Never a per-key loop.
 *
 * A pair owned by a DIFFERENT contact is never repointed (the backfill's
 * "never steals" rule, applied online) — it is skipped and logged as
 * `identity.alias.conflict` with the KIND and contact id only, never the value
 * (alias values are emails and account ids). Rows written here carry
 * `reason: 'resolve'` and `from_contact_id: NULL` — "this contact holds this
 * key right now", the index entry, not a provenance event — so the existing
 * `promote`/`merge` writers (which always run BEFORE this in their arms) win
 * the conflict and keep their provenance.
 *
 * The email pair is NORMALIZED (`normalizeEmail`) even when the legacy column
 * value is mixed-case, because the alias probe compares against the normalized
 * value the resolver always supplies.
 */
async function ensureIdentityAliases(tx: Tx, row: ContactRow): Promise<void> {
  const email = normalizeEmailOrNull(row.email);
  const pairs: { kind: Kind; value: string }[] = [];
  if (row.externalId) pairs.push({ kind: "external", value: row.externalId });
  if (email) pairs.push({ kind: "email", value: email });
  if (row.anonymousId)
    pairs.push({ kind: "anonymous", value: row.anonymousId });
  if (row.discordId) pairs.push({ kind: "discord", value: row.discordId });
  if (pairs.length === 0) return;

  const existing = await tx
    .select({
      aliasKind: contactAliases.aliasKind,
      aliasValue: contactAliases.aliasValue,
      contactId: contactAliases.contactId,
    })
    .from(contactAliases)
    .where(
      or(
        ...pairs.map((p) =>
          and(
            eq(contactAliases.aliasKind, p.kind),
            eq(contactAliases.aliasValue, p.value),
          ),
        ),
      ),
    );

  const held = new Map(
    existing.map((r) => [`${r.aliasKind}|${r.aliasValue}`, r.contactId]),
  );
  const foreignKinds = existing
    .filter((r) => r.contactId !== row.id)
    .map((r) => r.aliasKind);
  if (foreignKinds.length > 0) {
    logger.warn("identity.alias.conflict", {
      contactId: row.id,
      kinds: foreignKinds,
    });
  }

  const missing = pairs.filter((p) => !held.has(`${p.kind}|${p.value}`));
  if (missing.length === 0) return;

  await tx
    .insert(contactAliases)
    .values(
      missing.map((p) => ({
        contactId: row.id,
        aliasKind: p.kind,
        aliasValue: p.value,
        fromContactId: null,
        reason: ALIAS_REASON_RESOLVE,
      })),
    )
    .onConflictDoNothing({
      target: [contactAliases.aliasKind, contactAliases.aliasValue],
    });
}

/**
 * PRD 02 T1 — the erasure hook. Deletes EVERY `contact_aliases` row whose
 * `contact_id` is the erased contact — no `reason` filter, no `from_contact_id`
 * filter. Two earlier revisions of this rule each kept a subset and each kept a
 * leak: `promote` rows hold the person's own email; ABSORBED rows
 * (`from_contact_id` set) hold the same human's pre-merge email in the common
 * merge. The erasure question is "whose data is this?", and for any row keyed
 * to the erased contact the answer is always *theirs*.
 *
 * This does NOT strand `followToSurvivor`: that walk follows rows by
 * `from_contact_id = <loser>`, and those rows live under the SURVIVOR's
 * `contact_id` — erasing a loser touches none of them, and erasing a survivor
 * makes the chain into it moot (the alias probe only resolves live contacts).
 *
 * Called from both soft-delete sites (`softDeleteContact` and the admin
 * `DELETE /v1/admin/contacts/:id` route) inside their transactions. The merge
 * path's loser soft-delete is deliberately NOT a caller — a merge is a fold,
 * not an erasure, and its aliases (pointing at the survivor) are the mechanism
 * that keeps the loser's stale keys resolving.
 */
export async function deleteIdentityAliasesForContact(
  db: Database | Tx,
  contactId: string,
): Promise<void> {
  await db
    .delete(contactAliases)
    .where(eq(contactAliases.contactId, contactId));
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
  /** As {@link resolveOrCreateContact} (PRD 04). */
  linkUnlinks?: MergedLinkUnlink[];
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

  const rows = await db
    .select()
    .from(contacts)
    .where(and(or(...clauses), isNull(contacts.deletedAt)));

  // Identity-table fallback per supplied key (PRD 07 T7): a STALE
  // (merged-away) email or external id finds its survivor.
  const found = new Set(rows.map((r) => r.id));
  if (email && !rows.some((r) => r.email === email)) {
    const viaAlias = await resolveViaAlias(db, "email", email);
    if (viaAlias && !found.has(viaAlias.id)) {
      rows.push(viaAlias);
      found.add(viaAlias.id);
    }
  }
  if (userId && !rows.some((r) => r.externalId === userId)) {
    const viaAlias = await resolveViaAlias(db, "external", userId);
    if (viaAlias && !found.has(viaAlias.id)) rows.push(viaAlias);
  }
  return rows;
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
  /**
   * PRD 04 T5 (DECISIONS §15.3): one fact per live `linked_accounts` row this
   * delete soft-unlinked (token blobs hard-deleted alongside). PRD 08 emits
   * one `account.unlinked` per entry post-commit so mirrors converge. Absent
   * when the deleted contact(s) held no live links.
   */
  linkUnlinks?: ContactUnlinkFact[];
}> {
  const { db } = opts;
  const email = opts.email ? normalizeEmail(opts.email) : undefined;
  const userId = opts.userId?.trim() || undefined;

  // Annotated (unlike findContacts' evolving-any) because the array is read
  // inside the transaction closure below, where inference cannot follow it.
  const clauses: SQL[] = [];
  if (email) clauses.push(eq(contacts.email, email));
  if (userId) clauses.push(eq(contacts.externalId, userId));
  if (clauses.length === 0) return { deleted: false };

  // One transaction: the soft-delete and its erasure hook (PRD 02 T1 — every
  // contact_aliases row for the erased contact goes with it) commit or roll
  // back together, so a failure cannot leave identity keys stranded in the
  // alias table for a deleted person.
  const row = await db.transaction(async (tx) => {
    // Alias-aware target resolution (PRD 07 T7): erasing by a STALE
    // (merged-away) email or external id erases the SURVIVOR — the live row
    // that person's data folded into. Resolved inside the tx so the lookup,
    // the soft-delete and the erasure hook see one consistent state.
    const direct = await tx
      .select({
        id: contacts.id,
        externalId: contacts.externalId,
        email: contacts.email,
      })
      .from(contacts)
      .where(and(or(...clauses), isNull(contacts.deletedAt)));
    const targetIds = new Set(direct.map((r) => r.id));
    if (email && !direct.some((r) => r.email === email)) {
      const viaAlias = await resolveViaAlias(tx, "email", email);
      if (viaAlias) targetIds.add(viaAlias.id);
    }
    if (userId && !direct.some((r) => r.externalId === userId)) {
      const viaAlias = await resolveViaAlias(tx, "external", userId);
      if (viaAlias) targetIds.add(viaAlias.id);
    }
    if (targetIds.size === 0) return undefined;

    // PRD 04 T5 (DECISIONS §15.3): soft-unlink every live link the target(s)
    // hold, in this SAME transaction, each at its own pair's next version
    // through the store's tx-scoped helper — a live row outliving its owner
    // locks the `(provider, provider_user_id)` pair forever, so an erased
    // player could never relink their own account under onConflict "reject".
    // Tokens are hard-deleted alongside. Idempotent by construction: a target
    // with no live links contributes nothing.
    const linkUnlinks: ContactUnlinkFact[] = [];
    for (const targetId of targetIds) {
      linkUnlinks.push(
        ...(await unlinkAccountsForContactInTx(tx, targetId, {
          reason: "api",
        })),
      );
    }

    const updated = await tx
      .update(contacts)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(inArray(contacts.id, [...targetIds]), isNull(contacts.deletedAt)),
      )
      .returning({
        id: contacts.id,
        externalId: contacts.externalId,
        email: contacts.email,
      });
    // The or(email, userId) filter can match TWO distinct contacts in one
    // call; every soft-deleted row gets its erasure, not just the reported one.
    for (const deleted of updated) {
      await deleteIdentityAliasesForContact(tx, deleted.id);
    }
    return updated[0] ? { row: updated[0], linkUnlinks } : undefined;
  });

  if (!row) return { deleted: false };

  // THE CONTACT-DELETION `account.unlinked` EMIT (PRD 08 T3, DECISIONS §15.3),
  // one per live link, `reason: "api"`. Post-commit: the transaction above has
  // resolved, so a rollback never reaches this line.
  //
  // It lives HERE rather than at the callers because `softDeleteContact` has
  // THREE of them — `routes/contacts/index.ts`'s DELETE, the agent tool's
  // `delete_contact` arm, and any consumer-built deletion flow — and each one
  // that forgot would leave a customer's mirror recording a deleted player as
  // still linked, forever. The facts stay on the return value as well; that is
  // the reporting channel (and what the delete-leg tests assert), not a second
  // emit point. The admin erasure route runs its OWN transaction and therefore
  // owns its own post-commit emit (`routes/admin/contacts.ts`).
  emitAccountUnlinked(db, row.linkUnlinks);

  // NO journey-plane re-ingest here, deliberately (PRD 08 T5). Every other
  // `account.unlinked` site gets one; this one must not, for two independent
  // reasons:
  //
  //  1. The subject was just ERASED. Filing a fresh `user_events` row for a
  //     contact that was soft-deleted microseconds ago — and enrolling them in
  //     a journey that would then try to reach them — is the opposite of what
  //     a deletion means.
  //  2. There is no safe key anyway. The pin (`fact.owner.contactId`) resolves
  //     to a soft-deleted row with no merge alias to follow, so the re-ingest
  //     would be dropped as provenance-lost; and the only alternative,
  //     `owner.userId`, is a value key that `resolveOrCreateContact` would
  //     MINT a fresh contact for — RESURRECTING the row the caller just
  //     erased.
  //
  // The customer's mirror still converges: that is what the emit above is for.

  return {
    deleted: true,
    id: row.row.id,
    externalId: row.row.externalId,
    email: row.row.email,
    linkUnlinks: row.linkUnlinks.length > 0 ? row.linkUnlinks : undefined,
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

/**
 * Resolve the live contact that OWNS a canonical history key, for the PRD 04
 * `contact_id` DUAL-WRITE and nothing else.
 *
 * WHAT IT IS FOR. Every history row (`user_events`, `journey_states`,
 * `bucket_memberships`, `email_sends`, `email_preferences`) is stored under a
 * canonical STRING key (`external_id ?? anonymous_id ?? id`). The dual-write
 * stamps the owning `contacts.id` alongside it at insert time, so this must
 * resolve EXACTLY the key the row is stored under — no widening, no minting.
 * A miss is a legal, expected `null`: the column is nullable bookkeeping and a
 * later backfill fills what this could not see. Callers wrap it per D6 (a
 * bookkeeping resolve may never fail the operation it rides on).
 *
 * WHY ALIAS-AWARE. Since PRD 03 a second device's anonymous id can live ONLY in
 * `contact_aliases` (the contact row already carries a different
 * `anonymous_id`), so a column-only probe would stamp NULL for that visitor
 * FOREVER — the backfill reads the same columns and would miss it too. The
 * alias probe is restricted to kinds `external`/`anonymous` because those are
 * the only kinds a CANONICAL key can be: folding in an `email`/`discord` alias
 * would resolve history that today resolves to nothing, which is a read-shape
 * change smuggled in through a write. When both kinds carry the value,
 * `external` wins — mirroring the canonical-key precedence `external_id ??
 * anonymous_id` so the answer is deterministic rather than index-order luck.
 *
 * WHY NOT {@link findByKey}. That one takes a `(kind, value)` pair, probes
 * aliases FIRST across every kind, and carries a uuid-as-external fallback with
 * merge/mint semantics attached — resolution for a WRITE that may change the
 * identity graph. This is a read-only ownership question about one already-fixed
 * string, so it stays a separate, narrower probe.
 */
export async function lookupContactIdByKey(
  db: Database,
  key: string,
): Promise<string | null> {
  const value = key?.trim();
  if (!value) return null;

  // (1) COLUMN probe — one statement over the three indexed identity columns a
  // canonical key can occupy (Postgres serves the OR as a BitmapOr). The uuid
  // leg is REGEX-GUARDED rather than cast (`id::text = $1`): a bare cast is
  // unindexed AND an unguarded `id = $1` throws 22P02 on a non-uuid key.
  const direct = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        isNull(contacts.deletedAt),
        or(
          eq(contacts.externalId, value),
          eq(contacts.anonymousId, value),
          UUID_REGEX.test(value) ? eq(contacts.id, value) : undefined,
        ),
      ),
    )
    .limit(1);
  if (direct[0]) return direct[0].id;

  // (2) ALIAS probe — only reached on a column miss. `deleted_at IS NULL` lives
  // INSIDE the join (the live-target rule, as in `findByKey`): an alias whose
  // target is soft-deleted must produce NO row rather than stamp a tombstone.
  const viaAlias = await db
    .select({ id: contacts.id })
    .from(contactAliases)
    .innerJoin(
      contacts,
      and(
        eq(contacts.id, contactAliases.contactId),
        isNull(contacts.deletedAt),
      ),
    )
    .where(
      and(
        eq(contactAliases.aliasValue, value),
        inArray(contactAliases.aliasKind, ["external", "anonymous"]),
      ),
    )
    .orderBy(
      sql`case when ${contactAliases.aliasKind} = 'external' then 0 else 1 end`,
    )
    .limit(1);
  return viaAlias[0]?.id ?? null;
}

/** Alias-aware lookup helper (mirrors findByKey's alias probe but on the
 * top-level db handle, no tx). Engine-internal export: `resolveRecipient`
 * below and the feed's anonymous-recipient resolver (PRD 03 T5 — a second
 * device's anon id lives ONLY as an identity row) both fall back to it after
 * their column probes miss. */
export async function resolveViaAlias(
  db: Database | Tx,
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
