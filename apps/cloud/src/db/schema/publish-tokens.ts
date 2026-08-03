import { text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { cloud } from "./_shared";
import { environments } from "./environments";

/**
 * The bearer credential `hogsend publish` uploads with — one live token per
 * environment.
 *
 * The secret itself is NEVER here. Unlike `provider_keys`, which stores tenant
 * credentials ENCRYPTED because the control plane has to replay them to a
 * substrate, a publish token is only ever CHECKED — so it is stored as a
 * one-way sha256 and cannot be recovered by anyone holding the database, the
 * encryption secret, or a backup. A lost token is rotated, never looked up.
 *
 * `last4` is display-only, exactly as on `provider_keys`: enough for a customer
 * to tell which token a machine is using, useless to an attacker.
 *
 * No `updated_at`: the only mutation is a rotation, and `rotated_at` says so
 * precisely.
 */
export const publishTokens = cloud.table(
  "publish_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    /** sha256 hex of the whole token, prefix included. Never the token. */
    tokenHash: text("token_hash").notNull(),
    /** Display-only tail of the secret. */
    last4: text("last4").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Set on every re-issue; null while the original is still live. */
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  },
  (table) => [
    // ONE live token per environment. It is also the upsert target rotation
    // uses, so a rotation replaces rather than accumulates — two accepted
    // tokens for one environment would make "revoke" a lie.
    uniqueIndex("publish_tokens_environment_id_unique_idx").on(
      table.environmentId,
    ),
    // Verification's access path (a token names its own environment), and a
    // guarantee that no two environments can share a hash.
    uniqueIndex("publish_tokens_token_hash_unique_idx").on(table.tokenHash),
  ],
);
