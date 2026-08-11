import { index, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { cloud } from "./_shared";
import { environments } from "./environments";

/**
 * One row per message the relay has accepted for an environment, keyed by the
 * idempotency key the engine's mailer computed for it.
 *
 * THE UNIQUE INDEX IS THE CONCURRENCY GUARD, not a cache index. Journeys are
 * Hatchet durable tasks that replay from the top on a worker crash, an OOM or a
 * redeploy, so two identical sends can be genuinely in flight at the same
 * instant. A check-then-insert has a window between the two statements where
 * both requests read "not seen" and both reach SES; the "return the stored id"
 * behaviour then papers over it in testing, because both responses look right.
 * So the row is INSERTED FIRST and the unique violation is what tells us this
 * is a replay — the database serialises the decision, not the application.
 *
 * `message_id` is therefore NULLABLE, and its two states are the whole
 * protocol:
 *  - NULL  — a CLAIM. Somebody won the insert and is at the wire right now;
 *  - set   — the send completed and this is the id to replay to a retry.
 *
 * A row's EXISTENCE with a message id means the message reached SES. A send
 * that failed for any reason DELETES its claim, so a caller's retry can
 * succeed: an idempotency entry recorded for a message that never sent would
 * turn a transient blip into permanent silent loss (PRD 03, EARS 6).
 *
 * `claimed_at` is separate from `created_at` because they answer different
 * questions. `created_at` is immutable and drives retention. `claimed_at` is
 * the anchor for the stale-claim takeover: a process killed between the claim
 * and the send would otherwise poison that idempotency key forever, so a claim
 * older than the takeover window can be re-claimed by a compare-and-set on this
 * exact value, which lets exactly one contender through.
 */
export const emailIdempotency = cloud.table(
  "email_idempotency",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    /** The engine mailer's replay-stable key, verbatim. */
    idempotencyKey: text("idempotency_key").notNull(),
    /** The SES message id. NULL means "claimed, still at the wire". */
    messageId: text("message_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** When the live claim was taken. Reset by a stale-claim takeover. */
    claimedAt: timestamp("claimed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // The guard. Everything above depends on this index existing.
    uniqueIndex("email_idempotency_environment_key_unique_idx").on(
      table.environmentId,
      table.idempotencyKey,
    ),
    // The retention sweep's access path — scoped per environment, so the
    // opportunistic prune is a small indexed delete rather than a table scan.
    index("email_idempotency_environment_created_idx").on(
      table.environmentId,
      table.createdAt,
    ),
    // THE INBOUND CORRELATION'S access path (PRD 16 task 4). A received reply
    // names the message id it answers, and the ONLY safe way to use that
    // attacker-controlled string is to ask whether THIS environment sent it.
    // That question runs once per reply against the busiest table the relay
    // writes, so without this it is a sequential scan on the hot path — and
    // leading with `environment_id` is what makes the tenant scope part of the
    // index rather than a filter applied after the fact.
    index("email_idempotency_environment_message_id_idx").on(
      table.environmentId,
      table.messageId,
    ),
  ],
);
