import {
  boolean,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { cloud, timestamps } from "./_shared";
import { cloudRegionEnum, emailInboundStatusEnum } from "./enums";
import { environments } from "./environments";

/**
 * One row per message SES RECEIVED for a customer's `reply.<domain>` (PRD 16).
 *
 * It is a REFERENCE, never a copy. SES already wrote the raw MIME into S3
 * before it published the notification, so the durable store exists before this
 * row does; what this row adds is the only thing S3 cannot answer — whose
 * message it is, what we decided about it, and whether the decision has been
 * acted on. Duplicating the bytes into Postgres would double the blast radius
 * of raw mail from strangers for no answer we do not already have.
 *
 * Four reasons it exists, and dropping any one loses something real:
 *
 *  1. **It is the dedupe.** SNS is at-least-once, and the downstream effect of
 *     an inbound reply is an `email.replied` event a journey EXITS on. A
 *     duplicate would be harmless the second time and indistinguishable from a
 *     second genuine reply the tenth. `dedupe_key` is the arbiter.
 *  2. **It is the durable record written BEFORE anything is emitted.** PRD 16's
 *     ordering rule: "the failure that matters is a reply we accepted and then
 *     lost". So the row lands first and the instance hop settles it.
 *  3. **It is what makes forwarding possible at all** (task 6). The forwarder
 *     needs the bucket and key, and it needs to know a message it has not yet
 *     forwarded exists — an in-memory handoff would lose exactly the messages a
 *     restart happened during.
 *  4. **It is the evidence for a message that belongs to nobody.** A recipient
 *     that resolves to no environment is recorded with `environment_id = NULL`,
 *     the same posture `email_events` takes: an unresolved message is proof of
 *     a provisioning gap, and deleting the evidence is how the gap survives.
 *
 * **Nothing here is decoded attacker payload.** Subject, from, the text body
 * and the attachment manifest are all bounded (see `lib/inbound-mime.ts`) and
 * attachment BYTES are never read out of the parse, never written here and
 * never put on the wire — the PRD's line is "store, reference, and let the
 * customer opt in to retrieval".
 */
export const emailInboundMessages = cloud.table(
  "email_inbound_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /**
     * NULL when the envelope recipient resolved to no environment. See above.
     *
     * This column is the TENANT BOUNDARY, and it is derived from the envelope
     * recipient SES stated inside a signature-verified notification — never
     * from a header. Every header in a received message is attacker-controlled;
     * the recipient is the one fact AWS asserts.
     */
    environmentId: uuid("environment_id").references(() => environments.id, {
      onDelete: "cascade",
    }),
    /** Which regional endpoint received it. */
    region: cloudRegionEnum("region").notNull(),
    /** Content-derived identity — see `lib/ses-inbound-notifications.ts`. */
    dedupeKey: text("dedupe_key").notNull(),
    /** SES's own id for the RECEIVED message. Also the S3 object's basename. */
    sesMessageId: text("ses_message_id").notNull(),
    /** The envelope recipient that resolved, e.g. `hello@reply.acme.com`. */
    recipient: text("recipient").notNull(),
    /** Every envelope recipient SES matched, verbatim and in SES's order. */
    recipients: jsonb("recipients").$type<string[]>().notNull(),
    /** The customer domain this arrived for (`acme.com`), or NULL if unresolved. */
    domain: text("domain"),
    /** Where the raw MIME lives. The bucket is shared across regions. */
    bucket: text("bucket").notNull(),
    objectKey: text("object_key").notNull(),
    /** The stored object's size, as S3 reported it BEFORE anything was read. */
    sizeBytes: integer("size_bytes"),
    /** `From:`, as parsed. NULL when the message carried none. */
    fromAddress: text("from_address"),
    /** Bounded — a subject is a display string, not a payload. */
    subject: text("subject"),
    /**
     * The message id the sender CLAIMED to be replying to, verbatim and
     * UNVERIFIED. Kept for support ("why did this not thread?"), and
     * deliberately NOT the same column as {@link correlatedMessageId}.
     */
    inReplyTo: text("in_reply_to"),
    /**
     * The outbound SES message id this reply was PROVEN to answer — proven
     * meaning a send this same environment made. NULL is the honest answer for
     * everything else, including a forged `In-Reply-To` naming another tenant's
     * send, and a NULL here is never a reason to drop the message.
     */
    correlatedMessageId: text("correlated_message_id"),
    correlated: boolean("correlated").default(false).notNull(),
    /** Attachment METADATA only: filename, content type, size. Never bytes. */
    attachments: jsonb("attachments")
      .$type<{ filename: string | null; contentType: string; size: number }[]>()
      .default([])
      .notNull(),
    status: emailInboundStatusEnum("status").default("pending").notNull(),
    /**
     * Why no event was emitted, in our own vocabulary —
     * `auto_submitted` / `precedence_bulk` / `too_large` / `unresolved_recipient`.
     * NULL whenever an event was emitted.
     */
    reason: text("reason"),
    /** Instance delivery attempts so far. Bounded; never retried forever. */
    attempts: integer("attempts").default(0).notNull(),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    /** Whether the mandatory forward has happened yet (PRD 16 task 6). */
    forwardedAt: timestamp("forwarded_at", { withTimezone: true }),
    /** When SES received it — not when we heard about it. */
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    // THE dedupe. Global rather than per-environment, like `email_events`: the
    // key is derived from an id unique across the AWS account, and a message
    // that resolved to no environment has no environment to scope by.
    uniqueIndex("email_inbound_messages_dedupe_key_unique_idx").on(
      table.dedupeKey,
    ),
    // "what has this tenant received", newest first.
    index("email_inbound_messages_environment_created_idx").on(
      table.environmentId,
      table.createdAt,
    ),
    // The operator read, and (task 6) the forwarder's sweep: everything not yet
    // settled, everything suppressed, everything unresolved.
    index("email_inbound_messages_status_idx").on(table.status),
    // "what happened to this message" — the support question.
    index("email_inbound_messages_ses_message_id_idx").on(table.sesMessageId),
  ],
);
