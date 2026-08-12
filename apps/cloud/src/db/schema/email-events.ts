import {
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { cloud, timestamps } from "./_shared";
import { cloudRegionEnum, emailEventStatusEnum } from "./enums";
import { environments } from "./environments";

/**
 * One row per SES status event the control plane has consumed (PRD 05).
 *
 * It exists for three separate reasons, and dropping any one of them would
 * lose something real:
 *
 *  1. **It is the dedupe.** SNS delivery is at-least-once, so the same
 *     notification arrives more than once, and the engine's `handleWebhook`
 *     has NO dedupe of its own — confirmed by reading it, not assumed. It
 *     re-emits outbound events and increments a contact's bounce counter
 *     toward the suppression threshold on every call, so a duplicate bounce
 *     can suppress a deliverable address. The unique index on `dedupe_key` is
 *     what collapses the redelivery, and it is the ONLY thing that does.
 *  2. **It is the record for an event we cannot route.** An event whose SES
 *     tenant resolves to no environment is recorded here with
 *     `environment_id = NULL` and `status = 'dropped'`, keeping the tenant
 *     name SES stated. Broadcasting it to every instance instead would let
 *     one tenant's bounce suppress another tenant's contact.
 *  3. **It is where a terminal delivery failure lands.** Retry is bounded;
 *     what exhaustion produces is a `failed` row carrying the attempt count
 *     and the last error, not an endless retry loop.
 *
 * `environment_id` is deliberately NULLABLE. Every other tenant-scoped table
 * in this schema requires one, and this is the one place where "we received
 * something real that belongs to nobody we know" is a state worth keeping —
 * an unresolved event is evidence of a provisioning gap, and deleting the
 * evidence is how the gap survives.
 */
export const emailEvents = cloud.table(
  "email_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** NULL when the SES tenant resolved to no environment. See above. */
    environmentId: uuid("environment_id").references(() => environments.id, {
      onDelete: "cascade",
    }),
    /**
     * The SES tenant name exactly as the notification's tags stated it, kept
     * even (especially) when it resolved to nothing — that string is the whole
     * lead for diagnosing why.
     */
    tenantName: text("tenant_name"),
    /** Which regional endpoint received it. */
    region: cloudRegionEnum("region").notNull(),
    /** The content-derived identity of the event — `lib/ses-events.ts`. */
    dedupeKey: text("dedupe_key").notNull(),
    /** The relay event type, e.g. `email.bounced`. */
    type: text("type").notNull(),
    /** The SES message id — the id the engine's `email_sends` row keys on. */
    messageId: text("message_id").notNull(),
    /** The normalized `HogsendRelayEmailEvent`, verbatim SES `raw` included. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: emailEventStatusEnum("status").default("pending").notNull(),
    /** Instance delivery attempts made so far. Bounded; never retried forever. */
    attempts: integer("attempts").default(0).notNull(),
    /** The last delivery failure, in whoever refused it's own words. */
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    /** When SES says the event happened — not when we received it. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    // THE dedupe. Global rather than per-environment on purpose: the key is
    // derived from the SES message id, which is unique across the account, and
    // an unresolved event has no environment to scope by.
    uniqueIndex("email_events_dedupe_key_unique_idx").on(table.dedupeKey),
    // "what happened to this environment's mail", newest first.
    index("email_events_environment_created_idx").on(
      table.environmentId,
      table.createdAt,
    ),
    // The operator read: everything dropped or terminally failed.
    index("email_events_status_idx").on(table.status),
    // "what happened to this message" — the support question.
    index("email_events_message_id_idx").on(table.messageId),
  ],
);
