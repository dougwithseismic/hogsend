import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { campaigns } from "./campaigns.js";

/**
 * The channel-neutral cohort ledger for multi-step campaigns: one row per
 * (campaign, recipient), written exactly once per campaign at the FIRST
 * per-recipient wave (batch-inserted per pagination chunk, idempotent via the
 * (campaign_id, email) unique below). The audience is resolved once and
 * anchored here — a member added to the list afterwards never receives step 3
 * without step 1; every later wave qualifies FROM this table (∩ the step's
 * `where` conditions ∩ a fresh suppression/unsubscribe re-check — suppression
 * is never snapshotted).
 *
 * Why a table, not deriving the cohort from `email_sends` LIKE-attribution:
 * the cohort concept is channel-neutral — a campaign whose step 1 is email
 * and step 2 is a Discord DM needs ONE membership source both waves project
 * from. Per-channel delivery tables stay what they are (delivery + engagement
 * ledgers, stats attribution); membership lives here. It also makes every
 * wave-k qualifier query an indexed join instead of a LIKE scan. The column
 * layout leaves room for channel-native identities later (nullable userId;
 * see `docs/campaign-steps-spec.md` §campaign_recipients).
 */
export const campaignRecipients = pgTable(
  "campaign_recipients",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id),
    // The contact's externalId where the resolver knows it (bucket audiences
    // key on userId); nullable — list audiences may resolve email-only members.
    userId: text("user_id"),
    // Normalized at write (normalizeEmail) — the identity the unique dedupes
    // on and later waves join email_sends/email_preferences with.
    email: text("email").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Idempotent cohort writes: a retried first wave re-inserting a chunk
    // no-ops per (campaign, email) via onConflictDoNothing.
    uniqueIndex("campaign_recipients_campaign_email_idx").on(
      table.campaignId,
      table.email,
    ),
    // Keyset pagination for the wave delivery loops (per-campaign ORDER BY id,
    // WHERE id > cursor).
    index("campaign_recipients_campaign_id_id_idx").on(
      table.campaignId,
      table.id,
    ),
  ],
);
