import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";

/**
 * Single-use verification codes for the native in-connector identify loop
 * (Discord `/link <email>` → emailed code → `/verify <code>`). A member runs
 * `/link`, we mint a code, email it via Hogsend, and store ONLY a sha256 hash
 * of the code here (never the plaintext — the code lives only in the member's
 * inbox). `/verify` re-hashes the typed code, looks the row up by hash, and
 * redeems it: single-use (`used_at IS NULL` guard), TTL'd (`expires_at`), and
 * BOUND to the invoking platform user (`platform_user_id`, constant-time
 * compared) so a code is only valid for the same account that requested it.
 *
 * The `connector_id` + `target_email` columns also back the anti-email-bomb
 * throttle: the create path counts recent rows per invoking user AND per target
 * email within a rolling window and refuses to mint (and send) once either cap
 * is hit — counting on MINT (rows are never deleted on redeem/expiry, only
 * marked used / left to age out) is what makes it an email-bomb control.
 */
export const connectorLinkCodes = pgTable(
  "connector_link_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // The connector this code belongs to (e.g. "discord"). Scopes throttle
    // counts + lets one engine serve multiple connectors' link loops.
    connectorId: text("connector_id").notNull(),
    // sha256(code) as lowercase hex — the lookup key. The plaintext code is
    // NEVER stored; it exists only in the emailed message.
    codeHash: text("code_hash").notNull(),
    // The invoking platform user the code is BOUND to (Discord snowflake). A
    // redeem must present the SAME platform user id or it is rejected.
    platformUserId: text("platform_user_id").notNull(),
    // The authoritative email the code was issued for (the resolution key the
    // redeem attaches to the platform identity). Stored normalized
    // (trim + toLowerCase) by the caller.
    targetEmail: text("target_email").notNull(),
    // Absolute expiry. A redeem after this instant is rejected as expired.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // Single-use marker: NULL until redeemed, set to the redemption instant by
    // the atomic `UPDATE ... WHERE used_at IS NULL`. A second redeem misses.
    usedAt: timestamp("used_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // Redeem looks the row up by hash. Unique: a hash collision (or a duplicate
    // mint of the identical code) must never produce two redeemable rows.
    uniqueIndex("connector_link_codes_code_hash_idx").on(table.codeHash),
    // Serves the per-invoking-user throttle COUNT (connector + user + recency).
    index("connector_link_codes_throttle_user_idx").on(
      table.connectorId,
      table.platformUserId,
      table.createdAt,
    ),
    // Serves the per-target-email throttle COUNT (connector + email + recency).
    index("connector_link_codes_throttle_email_idx").on(
      table.connectorId,
      table.targetEmail,
      table.createdAt,
    ),
  ],
);
