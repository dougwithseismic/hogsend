import { jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";

/**
 * The generic overlay for GLOBAL operator choices made in Studio — the
 * `journey_configs` DB-config-overlay pattern, but keyed by SETTING NAME
 * instead of journey id. One row per setting (`key` is the primary key),
 * `value` is the setting's jsonb payload, whose shape each setting owns
 * (e.g. key `"fx"` → `{ baseCurrency: string | null }`, typed in the
 * engine's `lib/operator-settings.ts`).
 *
 * Deliberately generic: more global operator choices will land here (the
 * alternative — one table per toggle — buys nothing but migrations). The
 * semantics every setting shares: an ABSENT row means "the operator made no
 * choice" (env/boot defaults decide); a PRESENT row is the operator's
 * explicit word and overlays the env default, including explicitly turning
 * a feature OFF.
 */
export const operatorSettings = pgTable("operator_settings", {
  /** The setting's name — e.g. "fx". */
  key: text("key").primaryKey(),
  /** The setting's payload; shape is per-key, typed at the read/write site. */
  value: jsonb("value").notNull(),
  ...timestamps,
});
