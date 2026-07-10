import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { trackedLinks } from "./tracked-links.js";

export const linkClicks = pgTable(
  "link_clicks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    trackedLinkId: uuid("tracked_link_id")
      .notNull()
      .references(() => trackedLinks.id, { onDelete: "cascade" }),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    // The redirect target that was live WHEN this hit landed (pre-identity-
    // token). Per-hit provenance: after a re-target, stats stay attributable
    // to whichever destination each click/scan actually went to. NULL on rows
    // recorded before this column existed.
    destinationUrl: text("destination_url"),
    // Arrival stamp (POST /v1/t/arrive, first-write-wins): the visitor who
    // landed from THIS hit. `visitor_kind` records the trust tier —
    // 'token' = HMAC-verified userToken userId; 'anon' = the visitor's raw
    // self-declared anon id, PROVENANCE-ONLY forever (never an identity
    // assertion; never fed to the contact resolver as a subject).
    visitorDistinctId: text("visitor_distinct_id"),
    visitorKind: text("visitor_kind"),
    arrivedAt: timestamp("arrived_at", { withTimezone: true }),
    clickedAt: timestamp("clicked_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("link_clicks_tracked_link_id_idx").on(table.trackedLinkId),
    index("link_clicks_clicked_at_idx").on(table.clickedAt),
  ],
);
