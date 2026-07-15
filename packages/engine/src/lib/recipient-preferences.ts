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
 */
export async function readRecipientPreferences(
  db: Database,
  keys: { email?: string | null; userId?: string | null },
): Promise<RecipientPreferences> {
  const legs = [];
  if (typeof keys.email === "string" && keys.email.length > 0) {
    legs.push(eq(emailPreferences.email, keys.email));
  }
  if (typeof keys.userId === "string" && keys.userId.length > 0) {
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
