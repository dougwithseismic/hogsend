import { text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { cloud, timestamps } from "./_shared";
import { emailSendingStatusEnum } from "./enums";
import { environments } from "./environments";

/**
 * The control plane's MIRROR of whether one environment's SES tenant may send.
 *
 * PRD 08 writes it, from EventBridge and from its reconciliation sweep. PRD 03
 * creates it and READS it, on every relay request, before any network call —
 * which is the whole point: a paused tenant must be refused without spending a
 * round trip to be told so, and a tenant AWS has stopped for abuse must not get
 * an escape hatch through a retry loop.
 *
 * Absence of a row means `active`. That is deliberate rather than lazy: the
 * relay's gate is "is this environment BLOCKED", every environment starts
 * unblocked, and requiring a row to exist first would make a missing row (a
 * provision that half-ran, a backfill nobody ran) fail CLOSED for a tenant that
 * was never in trouble. The dangerous direction here is the other one — a
 * missed pause — and that is what PRD 08's `getReputationEntity` reconciliation
 * repairs.
 *
 * The relay itself also writes here, in one narrow case: when SES answers a
 * send with `tenant_paused` or `account_paused`, the state is persisted BEFORE
 * the response is returned, so the next request short-circuits without a
 * network call (PRD 03, EARS 5). That is a mirror repair, not a decision.
 */
export const emailSendingStatus = cloud.table(
  "email_sending_status",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    status: emailSendingStatusEnum("status").default("active").notNull(),
    /**
     * WHY, in whoever-stopped-it's own words — an AWS reputation cause, an
     * operator's note. Surfaced verbatim in the relay's 403 and through the
     * plugin, so a journey records a real reason rather than "send failed".
     */
    reason: text("reason"),
    /**
     * When this environment last entered a BLOCKING status; null while it is
     * sending. Named for what the 403 body carries rather than for the row, so
     * the two cannot drift. `updated_at` already answers "when did this row
     * change" and is a different question — a reason edited during an incident
     * moves that one and must not move this one.
     */
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    ...timestamps,
  },
  // One row per environment: the upsert arbiter and the read path in one.
  (table) => [
    uniqueIndex("email_sending_status_environment_id_unique_idx").on(
      table.environmentId,
    ),
  ],
);
