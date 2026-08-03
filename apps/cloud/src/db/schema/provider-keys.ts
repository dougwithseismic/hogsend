import { index, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { cloud, timestamps } from "./_shared";
import { environments } from "./environments";
import { organizations } from "./organizations";

/**
 * A tenant's third-party credential (resend / postmark / posthog / twilio / …),
 * scoped to one environment.
 *
 * Only ciphertext is ever stored: `encrypted_payload` is AES-256-GCM under
 * `CLOUD_ENCRYPTION_SECRET` (PRD 02 task 2) and `last4` exists solely so the UI
 * can show "…a91f" without a decrypt.
 */
export const providerKeys = cloud.table(
  "provider_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    /** Provider id, matching the engine's plugin ids ("resend", "twilio", …). */
    provider: text("provider").notNull(),
    encryptedPayload: text("encrypted_payload").notNull(),
    /** Display-only tail of the plaintext secret. */
    last4: text("last4"),
    /** Set when a live credential check last succeeded. */
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("provider_keys_organization_id_idx").on(table.organizationId),
    // The service's lookup AND its law: ONE key per provider per environment.
    // `ProviderKeyService.store()` is an upsert whose conflict target is this
    // index, so a re-store replaces the payload instead of accumulating rows
    // (which would make "which credential is live?" ambiguous).
    uniqueIndex("provider_keys_environment_provider_unique_idx").on(
      table.environmentId,
      table.provider,
    ),
  ],
);
