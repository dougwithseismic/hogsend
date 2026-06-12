import { pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";

/**
 * Provider-neutral credential store (OAuth tokens today, API keys later).
 * One row per (providerId, kind). `payload` is an AES-256-GCM blob
 * (base64url, keyed off BETTER_AUTH_SECRET) produced by the engine's
 * `lib/provider-credentials.ts` — NEVER plaintext JSON. It is `text`, not
 * `jsonb`, precisely because the contents must not be queryable: tokens are
 * opaque at the database layer by design.
 */
export const providerCredentials = pgTable(
  "provider_credentials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // e.g. "posthog" — matches an AnalyticsProvider meta.id by convention,
    // but deliberately NOT foreign-keyed: providers are code-defined.
    providerId: text("provider_id").notNull(),
    // "oauth" today; "api_key" is the anticipated future kind.
    kind: text("kind").notNull().default("oauth"),
    // Encrypted JSON: base64url(iv || ciphertext || gcmTag).
    payload: text("payload").notNull(),
    ...timestamps,
  },
  (table) => [
    // unique-per-kind: one oauth credential per provider; a future api_key
    // credential for the same provider coexists.
    uniqueIndex("provider_credentials_provider_kind_idx").on(
      table.providerId,
      table.kind,
    ),
  ],
);
