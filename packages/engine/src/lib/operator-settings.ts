import type { Database } from "@hogsend/db";
import { operatorSettings } from "@hogsend/db";
import { eq } from "drizzle-orm";

/**
 * Typed access to `operator_settings` — the generic overlay for GLOBAL
 * operator choices made in Studio (the `journey_configs` DB-config-overlay
 * pattern generalized to a KV keyed by setting name). An ABSENT row means
 * "the operator made no choice" and env/boot defaults decide; a PRESENT row
 * is the operator's explicit word and overlays env — including an explicit
 * "off".
 *
 * Deliberately NO cache (lean-first): every reader is a low-QPS admin/lens
 * surface where a primary-key lookup is nothing, and a cache would only add
 * an invalidation story across the API + worker processes for zero felt win.
 */

/** The `"fx"` operator setting — the Studio-chosen base currency. */
export const FX_SETTINGS_KEY = "fx";

/**
 * Value shape under {@link FX_SETTINGS_KEY}. `baseCurrency: null` is the
 * operator EXPLICITLY turning the lens off (beats env `BASE_CURRENCY`);
 * "fall back to env" is expressed by DELETING the row, never by a value.
 */
export interface FxSetting {
  baseCurrency: string | null;
}

/** Read one operator setting's value, or null when the row doesn't exist. */
export async function getOperatorSetting<T>(
  db: Database,
  key: string,
): Promise<T | null> {
  const [row] = await db
    .select({ value: operatorSettings.value })
    .from(operatorSettings)
    .where(eq(operatorSettings.key, key))
    .limit(1);
  return row ? (row.value as T) : null;
}

/** Upsert one operator setting (create and update are the same write). */
export async function putOperatorSetting(
  db: Database,
  key: string,
  value: unknown,
): Promise<void> {
  await db
    .insert(operatorSettings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: operatorSettings.key,
      set: { value, updatedAt: new Date() },
    });
}

/**
 * Remove one operator setting — "clear the override, fall back to env".
 * Returns whether a row was actually deleted (idempotent either way).
 */
export async function deleteOperatorSetting(
  db: Database,
  key: string,
): Promise<boolean> {
  const deleted = await db
    .delete(operatorSettings)
    .where(eq(operatorSettings.key, key))
    .returning({ key: operatorSettings.key });
  return deleted.length > 0;
}
