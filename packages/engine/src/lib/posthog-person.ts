import {
  contactAliases,
  contacts,
  crmLinks,
  type Database,
  POSTHOG_PERSON_LINK,
} from "@hogsend/db";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { normalizeEmailOrNull, resolveOrCreateContact } from "./contacts.js";

type ContactRow = typeof contacts.$inferSelect;

/** Postgres uuid syntax — guards the `contacts.id` probe below. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The alias kinds a PostHog distinct_id can have been demoted to. */
const DISTINCT_ID_ALIAS_KINDS = ["external", "anonymous"] as const;

/**
 * Everything Hogsend knows about a PostHog person at resolution time: the
 * stable `person_id` plus the volatile key set it spans.
 *
 * `personId` is nullable on purpose — it is exactly the shape
 * `getPerson` (`@hogsend/plugin-posthog`) returns when person READS are
 * disabled (no `POSTHOG_PERSONAL_API_KEY`, no OAuth token) or when the upstream
 * read soft-failed. A null `personId` degrades both functions to value-only
 * resolution with no mapping write; it never throws.
 */
export interface PostHogPersonRef {
  /** PostHog's internal `person_id`. Null when reads are disabled/failed. */
  personId?: string | null;
  /**
   * EVERY distinct_id PostHog lists under the person. Order is meaningless —
   * PostHog does not promise one, and it changes between polls. Both functions
   * normalize (trim, dedupe, sort) before doing anything, so the same set in a
   * different order always produces the same answer.
   */
  distinctIds?: readonly string[] | null;
  /** The person's email, if PostHog carries one. Normalized before use. */
  email?: string | null;
}

interface NormalizedKeys {
  personId: string | null;
  /** Trimmed, de-duplicated, LEXICOGRAPHICALLY SORTED — never arrival order. */
  distinctIds: string[];
  email: string | null;
}

function normalizeKeys(ref: PostHogPersonRef): NormalizedKeys {
  const distinctIds = [
    ...new Set(
      (ref.distinctIds ?? [])
        .map((value) => value?.trim())
        .filter((value): value is string => !!value),
    ),
  ].sort();
  return {
    personId: ref.personId?.trim() || null,
    distinctIds,
    email: normalizeEmailOrNull(ref.email),
  };
}

/**
 * The deterministic winner when several live contacts match the key set. Same
 * ordering as the resolver's SURVIVOR RULE (`contacts.ts` `pickSurvivor`):
 * identified (has `external_id`) beats anonymous, then OLDEST `firstSeenAt`,
 * then lowest id. Keeping the two rules identical means a lookup and a
 * subsequent merge never disagree about which row is canonical.
 *
 * Deliberately does NOT merge the losers. PostHog asserting "these keys are one
 * person" is not evidence Hogsend's contacts should be folded — over-matching is
 * the direction that produced the 0.36.1 value-fold hole, and a mapped alias
 * exists precisely so a person id can join without touching identity columns.
 */
function pickCanonical(rows: ContactRow[]): ContactRow | null {
  const sorted = [...rows].sort((a, b) => {
    const aIdent = a.externalId ? 0 : 1;
    const bIdent = b.externalId ? 0 : 1;
    if (aIdent !== bIdent) return aIdent - bIdent;
    const aSeen = a.firstSeenAt.getTime();
    const bSeen = b.firstSeenAt.getTime();
    if (aSeen !== bSeen) return aSeen - bSeen;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return sorted[0] ?? null;
}

/**
 * The stored mapping leg: `person_id` → live contact. A row pointing at a
 * soft-deleted (merged-away, or deleted) contact resolves null here so the
 * caller falls through and RE-RESOLVES — AC 4. `mergeContacts` already
 * re-points `crm_links` loser→survivor, so this is the belt to that braces.
 */
async function findByMapping(
  db: Database,
  personId: string,
): Promise<ContactRow | null> {
  const rows = await db
    .select({ contact: contacts })
    .from(crmLinks)
    .innerJoin(contacts, eq(contacts.id, crmLinks.contactId))
    .where(
      and(
        eq(crmLinks.provider, POSTHOG_PERSON_LINK.provider),
        eq(crmLinks.kind, POSTHOG_PERSON_LINK.kind),
        eq(crmLinks.externalId, personId),
        isNull(contacts.deletedAt),
      ),
    )
    .limit(1);
  return rows[0]?.contact ?? null;
}

/**
 * FIND-ONLY value resolution across the WHOLE key set. Every distinct_id is
 * probed against `external_id` AND `anonymous_id` (a PostHog distinct_id is
 * either, depending on whether the person was identified) plus, when it is
 * uuid-shaped, `contacts.id` — an email-only/anon-only contact's canonical key
 * IS its row id, and that key leaves the system. The email is probed against
 * `contacts.email`.
 *
 * Stale keys fall back to `contact_aliases`, so a distinct_id that belonged to
 * a merge loser still resolves to the SURVIVOR instead of reading as unknown.
 *
 * Creates nothing. `resolveOrCreateContact` cannot stand in here: it has no
 * find-only mode and a zero-candidate call inserts unconditionally.
 */
async function findByValue(
  db: Database,
  keys: NormalizedKeys,
): Promise<ContactRow | null> {
  const { distinctIds, email } = keys;
  if (distinctIds.length === 0 && !email) return null;

  const uuids = distinctIds.filter((value) => UUID_PATTERN.test(value));
  const hasDistinctIds = distinctIds.length > 0;

  const direct = await db
    .select()
    .from(contacts)
    .where(
      and(
        or(
          hasDistinctIds
            ? inArray(contacts.externalId, distinctIds)
            : undefined,
          hasDistinctIds
            ? inArray(contacts.anonymousId, distinctIds)
            : undefined,
          uuids.length > 0 ? inArray(contacts.id, uuids) : undefined,
          email ? eq(contacts.email, email) : undefined,
        ),
        isNull(contacts.deletedAt),
      ),
    );

  const aliased = await db
    .select({ contact: contacts })
    .from(contactAliases)
    .innerJoin(contacts, eq(contacts.id, contactAliases.contactId))
    .where(
      and(
        or(
          hasDistinctIds
            ? and(
                inArray(contactAliases.aliasKind, [...DISTINCT_ID_ALIAS_KINDS]),
                inArray(contactAliases.aliasValue, distinctIds),
              )
            : undefined,
          email
            ? and(
                eq(contactAliases.aliasKind, "email"),
                eq(contactAliases.aliasValue, email),
              )
            : undefined,
        ),
        isNull(contacts.deletedAt),
      ),
    );

  const candidates = new Map<string, ContactRow>();
  for (const row of direct) candidates.set(row.id, row);
  for (const row of aliased) candidates.set(row.contact.id, row.contact);
  return pickCanonical([...candidates.values()]);
}

/**
 * Write (or repair) the `person_id` → contact mapping on the
 * `(provider, kind, external_id)` unique arbiter. Idempotent: the same person
 * resolving to the same contact is a no-op write, and a stale pointer is
 * re-pointed rather than duplicated.
 */
async function rememberMapping(
  db: Database,
  personId: string,
  contactId: string,
): Promise<void> {
  await db
    .insert(crmLinks)
    .values({ ...POSTHOG_PERSON_LINK, externalId: personId, contactId })
    .onConflictDoUpdate({
      target: [crmLinks.provider, crmLinks.kind, crmLinks.externalId],
      set: { contactId },
    });
}

async function loadContact(
  db: Database,
  id: string,
): Promise<ContactRow | null> {
  const rows = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, id), isNull(contacts.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * FIND-ONLY: is this PostHog person already a Hogsend contact?
 *
 * Mapping lookup first (`person_id` → contact), then a find-only value lookup
 * across the whole distinct_id set plus email. **Creates nothing** — no
 * `contacts` row, no mapping row, and never a call to `resolveOrCreateContact`
 * (which has no find-only mode: a zero-candidate call inserts unconditionally).
 * This is the function every READ path consumes — the cohort diff, dry-runs,
 * reconciliation.
 *
 * The mapping is persisted/repaired only when a contact IS found and a
 * `personId` was supplied. A mapping that points at a contact which was merged
 * away or deleted is treated as a miss and RE-RESOLVED, never reported as
 * absent.
 *
 * `{ found: null }` means "no Hogsend contact carries any of these keys". It
 * does NOT mean "this person left" and must never be fed to a membership
 * REMOVAL: removals are driven by the upstream membership set, never by a
 * resolution outcome.
 *
 * Soft-fails to `{ found: null }` — never throws — when nothing identifies the
 * person, which is the shape a deployment with no PostHog credential produces.
 */
export async function lookupPostHogPerson(
  opts: PostHogPersonRef & { db: Database },
): Promise<{ found: ContactRow | null }> {
  const { db } = opts;
  const keys = normalizeKeys(opts);

  if (keys.personId) {
    const mapped = await findByMapping(db, keys.personId);
    if (mapped) return { found: mapped };
  }

  const found = await findByValue(db, keys);
  if (!found) return { found: null };

  if (keys.personId) await rememberMapping(db, keys.personId, found.id);
  return { found };
}

/**
 * CREATING: resolve this PostHog person to a Hogsend contact, materializing one
 * if none exists. Use ONLY where creating a contact is intended — every read
 * path wants {@link lookupPostHogPerson}.
 *
 * Runs the same whole-set lookup first (mapping, then find-only value
 * resolution). Only a lookup that misses EVERY key falls through to
 * `resolveOrCreateContact`, tagged with the caller's explicit `source`. Doing
 * the whole-set lookup first is load-bearing: `resolveOrCreateContact` accepts
 * one external key, so handing it a single distinct_id from a multi-id person
 * would mint a phantom twin whenever the existing contact happens to be keyed
 * on one of the others.
 *
 * The distinct_id handed to the create leg is the lexicographically first of
 * the normalized set, so the created contact's `external_id` does not depend on
 * the order PostHog listed them in. The remaining distinct_ids are NOT attached
 * as identity keys — a contact holds one `external_id`; spanning the whole set
 * is exactly the job the `person_id` mapping row does.
 *
 * Soft-fails to `{ contact: null, created: false }` — never throws — when
 * nothing identifies the person (no distinct_id, no email), which is the shape
 * a deployment with no PostHog credential produces.
 */
export async function resolvePostHogPerson(
  opts: PostHogPersonRef & {
    db: Database;
    /** Provenance stamped on a newly created contact (first-touch only). */
    source: string;
  },
): Promise<{ contact: ContactRow | null; created: boolean }> {
  const { db, source } = opts;
  const keys = normalizeKeys(opts);

  const existing = await lookupPostHogPerson({ db, ...keys });
  if (existing.found) return { contact: existing.found, created: false };

  const primary = keys.distinctIds[0];
  if (!primary && !keys.email) return { contact: null, created: false };

  const resolved = await resolveOrCreateContact({
    db,
    userId: primary,
    email: keys.email ?? undefined,
    source,
  });
  const contact = await loadContact(db, resolved.id);
  if (contact && keys.personId) {
    await rememberMapping(db, keys.personId, contact.id);
  }
  return { contact, created: resolved.created };
}
