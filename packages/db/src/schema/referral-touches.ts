import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { contacts } from "./contacts.js";
import { conversions } from "./conversions.js";
import { links } from "./links.js";

/**
 * The referral EDGE LOG (PRD 05 §5.2): one row per touch - "this referrer
 * reached this referee, this way, at this time". Rows are append-only apart
 * from the bind/qualify/reject stamps; nothing weighted is ever stored here.
 *
 * Model, window, depth and level weights are REPORT-TIME parameters, so the
 * table holds only facts. Revenue lives in `conversions` / `deals` and the
 * credit split lives in `attribution_credits`; this table is only the tree.
 */
export const referralTouches = pgTable(
  "referral_touches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /**
     * The `defineReferral` id (default "default"). NOT foreign-keyed:
     * referrals are code-defined, exactly like `journey_states.journey_id`.
     */
    referralId: text("referral_id").notNull(),
    /**
     * The credited referrer - `links.owner_contact_id` READ AT TOUCH TIME and
     * denormalized on purpose. Retargeting or re-owning a link later must not
     * silently rewrite who earned last quarter's referrals.
     */
    referrerContactId: uuid("referrer_contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /**
     * The canonical key of whoever touched: an ANONYMOUS id on a cold touch,
     * or the contact key when the toucher was already identified. This is the
     * value `adoptOrphanHistory` scans for at identify time, so it must be
     * written exactly as `contactKey()` would produce it.
     */
    refereeKey: text("referee_key").notNull(),
    /**
     * Stamped at BIND (identity adoption), or immediately when the toucher was
     * already identified. NULL = the edge has one end only, which is the whole
     * reason `referral_touches_referee_key_unbound_idx` exists.
     */
    refereeContactId: uuid("referee_contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    /** The `shared` link that was clicked. NULL for manual/import touches. */
    linkId: uuid("link_id").references(() => links.id, {
      onDelete: "set null",
    }),
    /**
     * The `link_clicks.id` this touch came from - the replay key for the touch
     * write. NO FK: clicks and the referral ledger are retained on different
     * schedules, and losing a click must never delete an edge.
     */
    clickId: uuid("click_id"),
    /** "link" | "slug_entry" | "invite" | "manual" | "import". */
    source: text("source").notNull(),
    touchedAt: timestamp("touched_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    boundAt: timestamp("bound_at", { withTimezone: true }),
    /** "touched" | "bound" | "qualified" | "rejected". */
    status: text("status").notNull().default("touched"),
    /** "self" | "window" | "veto" | "bot" | "duplicate". NULL unless rejected. */
    rejectedReason: text("rejected_reason"),
    qualifiedAt: timestamp("qualified_at", { withTimezone: true }),
    qualifiedConversionId: uuid("qualified_conversion_id").references(
      () => conversions.id,
      { onDelete: "set null" },
    ),
    /**
     * Scalar bag from `beforeTouch` / the invite call (`refereeEmailHint`,
     * campaign, the caller's idempotency key). Never read for identity.
     */
    properties: jsonb("properties")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // "what did this referee's tree look like" - the bind + report drill-in.
    index("referral_touches_referee_idx").on(
      table.refereeContactId,
      table.referralId,
      table.touchedAt,
    ),
    // "what has this referrer produced" - the leaderboard.
    index("referral_touches_referrer_idx").on(
      table.referrerContactId,
      table.referralId,
    ),
    // THE ADOPT SCAN. Partial on the unbound rows only: the scan runs on every
    // identify, and the bound rows (the overwhelming majority, forever) are
    // dead weight in a full index on this column.
    index("referral_touches_referee_key_unbound_idx")
      .on(table.refereeKey)
      .where(sql`referee_contact_id IS NULL`),
    // THE EDGE. The same (referral, referee, referrer) triple is ONE edge no
    // matter how many times the link is clicked, so a re-touch is a no-op at
    // the database rather than a judgement call in the store. Partial on
    // `status <> 'rejected'` so a rejected touch never blocks a later
    // legitimate one (a window rejection today, a valid re-touch tomorrow),
    // and so a DIFFERENT referrer is always a new row - last-touch models can
    // only see an edge that was written.
    uniqueIndex("referral_touches_edge_idx")
      .on(table.referralId, table.refereeContactId, table.referrerContactId)
      .where(sql`status <> 'rejected'`),
  ],
);
