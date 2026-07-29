import { type Database, emailPreferences } from "@hogsend/db";
import { eq, or } from "drizzle-orm";

/** Aggregated preference verdict across every row matching a recipient. */
export interface RecipientPreferences {
  /** true when any matching row has the global master opt-out. */
  unsubscribedAll: boolean;
  /** true when any matching row carries an email suppression signal. */
  suppressed: boolean;
  /** Category map merged across rows, with an explicit false always winning. */
  categories: Record<string, boolean>;
}

/**
 * Read the conservative preference verdict shared by email, feed, and
 * connector delivery. This module intentionally contains no Hatchet/runtime
 * imports so journey authoring modules remain safe to load in unit tests.
 *
 * The subject leg follows the `bySubject` law (PRD 05): when `contactId` is
 * known, rows are matched by ownership stamp ONLY — never OR'd with the
 * mutable string key, which goes stale the moment the contact adopts a new
 * canonical key. `contactId` is REQUIRED (pass `null` explicitly for a
 * contactless subject) so a new caller cannot silently default onto the
 * string key. The email leg is orthogonal: address-scoped suppression
 * (imports, bounces) predates the contact and stays an OR leg.
 */
export async function readRecipientPreferences(
  db: Database,
  keys: {
    email?: string | null;
    userId?: string | null;
    contactId: string | null;
  },
): Promise<RecipientPreferences> {
  const legs = [];
  if (typeof keys.email === "string" && keys.email.length > 0) {
    legs.push(eq(emailPreferences.email, keys.email));
  }
  if (keys.contactId) {
    legs.push(eq(emailPreferences.contactId, keys.contactId));
  } else if (typeof keys.userId === "string" && keys.userId.length > 0) {
    legs.push(eq(emailPreferences.userId, keys.userId));
  }

  if (legs.length === 0) {
    return { unsubscribedAll: false, suppressed: false, categories: {} };
  }

  const rows = await db
    .select()
    .from(emailPreferences)
    .where(or(...legs));

  const categories: Record<string, boolean> = {};
  for (const prefs of rows) {
    const map = (prefs.categories ?? {}) as Record<string, boolean>;
    for (const [key, value] of Object.entries(map)) {
      categories[key] = (categories[key] ?? true) && value;
    }
  }

  return {
    unsubscribedAll: rows.some((row) => row.unsubscribedAll),
    suppressed: rows.some((row) => row.suppressed),
    categories,
  };
}
