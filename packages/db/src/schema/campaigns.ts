import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";

/**
 * One-shot campaign / broadcast (Loops "campaign" parity): a single email
 * template sent to every subscribed member of a LIST (or every active member of
 * a BUCKET). A row is created in `queued` by `POST /v1/campaigns`, then the
 * durable `send-campaign` Hatchet task transitions it `sending → sent`/`failed`
 * and tallies the final counts.
 *
 * `status` is a plain text column (not an enum) so adding a future state needs
 * no migration; the app constrains it to `queued|sending|sent|failed`.
 *
 * `audienceKind` + `audienceId` reference a code-defined list (ListRegistry) or
 * bucket (BucketRegistry) by string id — NOT a contacts FK, so there is no
 * relation to wire.
 */
export const campaigns = pgTable(
  "campaigns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id"),
    name: text("name").notNull(),
    // queued | sending | sent | failed
    status: text("status").notNull().default("queued"),
    // "list" | "bucket"
    audienceKind: text("audience_kind").notNull(),
    // the list id (ListRegistry) or bucket id (BucketRegistry)
    audienceId: text("audience_id").notNull(),
    templateKey: text("template_key").notNull(),
    props: jsonb("props").$type<Record<string, unknown>>().default({}),
    fromEmail: text("from_email"),
    subject: text("subject"),
    /**
     * Optional client-supplied idempotency key (POST /v1/campaigns
     * `Idempotency-Key` header / body field). A retried create with the same key
     * resolves to the EXISTING campaign instead of spawning a second broadcast
     * (a distinct campaignId would give the same recipient a different per-send
     * idempotency key, double-sending the blast). Uniqueness is enforced by the
     * partial-unique index below (NULL keys are unconstrained).
     */
    idempotencyKey: text("idempotency_key"),
    totalRecipients: integer("total_recipients").notNull().default(0),
    sentCount: integer("sent_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("campaigns_status_idx").on(table.status),
    index("campaigns_created_at_idx").on(table.createdAt),
    // Partial-unique on the client idempotency key (scoped to non-NULL keys so
    // the common keyless create is unconstrained). A retried create with the
    // same key collides here and resolves to the existing campaign.
    uniqueIndex("campaigns_idempotency_key_idx")
      .on(table.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
  ],
);
