import { text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { cloud } from "./_shared";
import { environments } from "./environments";

/**
 * The bearer credential a tenant instance presents to the email relay
 * (`POST /api/email/send`) — one live token per environment.
 *
 * It is NOT a `provider_keys` row, and the difference is not stylistic.
 * `provider_keys` stores reversible AES-256-GCM ciphertext keyed by
 * `(environment_id, provider)`, which answers "what is THIS environment's
 * credential". The relay asks the opposite question — "which environment does
 * this bearer token belong to" — and that one cannot be answered from a
 * reversible store without decrypting every row on every request. Different
 * question, different storage: the presented token is hashed and the hash is
 * looked up directly, one indexed read.
 *
 * The hash is an HMAC-SHA-256 under `CLOUD_ENCRYPTION_SECRET`, not a password
 * KDF. The token is 32 bytes of CSPRNG output, so there is no dictionary to
 * mount against it and a per-request bcrypt would price the relay out — a
 * journey fan-out sends thousands of messages a minute. The key is what stops a
 * stolen database alone from confirming a guessed token offline.
 *
 * The environment this row points at is the ONLY source of the SES
 * `TenantName`. A relay request may not name its own tenant; if it could,
 * tenant isolation would be advisory (DECISIONS §3.2).
 *
 * No `updated_at`: the only mutation is a rotation, and `rotated_at` says so
 * precisely.
 */
export const relayTokens = cloud.table(
  "relay_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    /** HMAC-SHA-256 hex of the whole token, prefix included. Never the token. */
    tokenHash: text("token_hash").notNull(),
    /** Display-only tail of the secret, exactly as on `publish_tokens`. */
    last4: text("last4").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Set on every re-issue; null while the original is still live. */
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  },
  (table) => [
    // ONE live token per environment, and the upsert target a rotation aims at,
    // so a rotation REPLACES rather than accumulates — two accepted tokens for
    // one environment would make "revoke" a lie.
    uniqueIndex("relay_tokens_environment_id_unique_idx").on(
      table.environmentId,
    ),
    // Verification's whole access path: a token names its own environment in
    // one indexed lookup, and no two environments can share a hash.
    uniqueIndex("relay_tokens_token_hash_unique_idx").on(table.tokenHash),
  ],
);
