import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id"),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default(["read"]),
    // Per-key browser Origin allowlist for PUBLISHABLE (pk_) keys. NULLABLE:
    // null/empty ⇒ FAIL-CLOSED for a publishable key (the request guard rejects
    // a pk_ key with no allowlist or an Origin not in it). Secret (hsk_) keys
    // ignore this column entirely. Enforcement lives in the request guard
    // (`requirePublishableOrIngest`), NOT a DB constraint.
    allowedOrigins: text("allowed_origins").array(),
    createdBy: text("created_by"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("api_keys_key_hash_idx").on(table.keyHash),
    index("api_keys_revoked_at_idx").on(table.revokedAt),
  ],
);
