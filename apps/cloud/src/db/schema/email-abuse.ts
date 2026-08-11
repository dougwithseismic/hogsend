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
import {
  emailAbuseEventOutcomeEnum,
  emailFindingStatusEnum,
  emailPauseSourceEnum,
  emailSendingStatusEnum,
} from "./enums";
import { environments } from "./environments";

/**
 * PRD 08's four tables: the EventBridge journal, the findings, the pause
 * history, and the daily send counter the `new` tier's cap is judged against.
 *
 * They are separate tables because they have separate writers and separate
 * readers, and folding any pair together would make one of them lie:
 *
 *  - the JOURNAL is written once per EventBridge delivery, including for a
 *    tenant we cannot resolve, so its `environment_id` is nullable;
 *  - PAUSE HISTORY is per environment and includes transitions EventBridge
 *    never saw (the relay discovering a pause at the wire, an operator stop),
 *    so it cannot be a view over the journal;
 *  - FINDINGS are current state with a lifecycle, not a log — a finding that
 *    opens and later closes is one row that changed, and the tier engine asks
 *    "how many are open right now";
 *  - DAILY SENDS is a counter, upserted on the send path.
 */

/**
 * Every SES reputation event this control plane has consumed, verbatim.
 *
 * It carries three jobs at once, and each of them is load-bearing:
 *
 *  1. **It is the idempotency gate.** EventBridge delivery is at-least-once.
 *     The unique index on `event_id` is what makes a redelivered pause a no-op
 *     rather than a second suspension email into a customer's inbox at the
 *     worst possible moment.
 *  2. **It is the record for an event we cannot route.** An event whose SES
 *     tenant resolves to no environment lands here with `environment_id = NULL`
 *     and `outcome = 'unknown_tenant'`, keeping the tenant name SES stated.
 *     Throwing instead would let one stale tenant wedge the pipeline for every
 *     live one (EARS 9), and dropping it would delete the evidence of the
 *     provisioning gap that produced it.
 *  3. **It is the notice ledger.** `notified_at` is claimed conditionally
 *     (`WHERE notified_at IS NULL`), so the suspension notice is sent exactly
 *     once per pause event even if two replicas handle the same delivery.
 *
 * `handled_at` is what distinguishes a REDELIVERY (handled, so a no-op) from a
 * RESUME (row exists, handling never finished — a crash mid-flight), which is
 * the only reason the journal insert can be the claim and still be recoverable.
 */
export const emailAbuseEvents = cloud.table(
  "email_abuse_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** EventBridge's own event id. THE dedupe key. */
    eventId: text("event_id").notNull(),
    /** `Sending Status Disabled`, `Advisor Recommendation Status Open`, … */
    detailType: text("detail_type").notNull(),
    /** The SES tenant the event named, kept even when it resolved to nothing. */
    tenantName: text("tenant_name"),
    /** NULL when the tenant resolved to no environment. See above. */
    environmentId: uuid("environment_id").references(() => environments.id, {
      onDelete: "cascade",
    }),
    /** When SES says it happened — not when we received it. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** The whole EventBridge envelope. Never discard AWS's own answer. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /** What we did. NULL until handling finished — see `handled_at`. */
    outcome: emailAbuseEventOutcomeEnum("outcome"),
    /** Set when handling COMPLETED; NULL marks a run that died mid-flight. */
    handledAt: timestamp("handled_at", { withTimezone: true }),
    /** When the suspension notice went out for THIS pause event. */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    /** Why the notice could not be sent, in the transport's own words. */
    noticeError: text("notice_error"),
    ...timestamps,
  },
  (table) => [
    // THE dedupe, and the claim. Global rather than per-environment: an
    // EventBridge id is unique across the account, and an unresolved event has
    // no environment to scope by.
    uniqueIndex("email_abuse_events_event_id_unique_idx").on(table.eventId),
    // "what has happened to this tenant", newest first.
    index("email_abuse_events_environment_created_idx").on(
      table.environmentId,
      table.createdAt,
    ),
    // The operator read: everything that resolved to nobody.
    index("email_abuse_events_outcome_idx").on(table.outcome),
  ],
);

/**
 * One SES Advisor reputation finding against one environment.
 *
 * Keyed on `(environment_id, type)` because that is how SES itself identifies a
 * recommendation — one BOUNCE finding per resource, not a stream of them — so a
 * re-raised finding UPDATES rather than accumulating. Without that arbiter the
 * open-finding count would grow with every redelivery and a tenant could never
 * leave `watched` even after the cause was fixed.
 */
export const emailFindings = cloud.table(
  "email_findings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    /** SES's own recommendation type: `BOUNCE`, `COMPLAINT`, `DKIM`, `SPF`, … */
    type: text("type").notNull(),
    /** `HIGH` / `LOW`, verbatim. Kept as text: it is AWS's vocabulary. */
    impact: text("impact"),
    description: text("description"),
    status: emailFindingStatusEnum("status").default("open").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Set when SES reported the recommendation fixed; null while open. */
    closedAt: timestamp("closed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("email_findings_environment_type_unique_idx").on(
      table.environmentId,
      table.type,
    ),
    // "how many findings are open for this tenant" — the tier engine's read,
    // and the Studio panel's.
    index("email_findings_environment_status_idx").on(
      table.environmentId,
      table.status,
    ),
  ],
);

/**
 * One row per sending-status TRANSITION, for one environment.
 *
 * A log, not state: `email_sending_status` already answers "can this
 * environment send right now" and is the only thing the relay reads. This
 * answers "how did it get here", which is the question a human asks during an
 * appeal and the one AUP §6.4 ("a second suspension for the same clause")
 * cannot be applied without.
 *
 * Appended from the single choke point that writes the status, so a pause the
 * RELAY discovered at the wire is in here beside one EventBridge delivered.
 */
export const emailPauseHistory = cloud.table(
  "email_pause_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    status: emailSendingStatusEnum("status").notNull(),
    /** The recorded cause, verbatim — the same sentence the relay's 403 carries. */
    reason: text("reason"),
    source: emailPauseSourceEnum("source").notNull(),
    /** The EventBridge event that caused it, when one did. */
    eventId: text("event_id"),
    /** When the transition happened, as its source dated it. */
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
    ...timestamps,
  },
  (table) => [
    index("email_pause_history_environment_at_idx").on(
      table.environmentId,
      table.at,
    ),
  ],
);

/**
 * Relay sends per environment per DAY.
 *
 * `usage_counters` already counts the month, and the month is the billing
 * question. This is the abuse question: the `new` tier's whole defence is a
 * daily ceiling (AUP §5.2), and a monthly counter cannot answer "how many today"
 * without a second dimension the billing arbiter cannot carry.
 *
 * Written by the SAME post-wire meter that writes `usage_counters`, so the two
 * cannot describe different populations, and by UPSERT for the same reason: a
 * read-modify-write silently undercounts under load, and an undercounted abuse
 * cap is an abuse cap that does not hold.
 *
 * `day` is the UTC calendar day as `YYYY-MM-DD`. A text column rather than a
 * date, matching `usage_counters.month`, so the arbiter is a plain equality on
 * a value the application computes once.
 */
export const emailDailySends = cloud.table(
  "email_daily_sends",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    /** `YYYY-MM-DD`, UTC. */
    day: text("day").notNull(),
    count: integer("count").default(0).notNull(),
    ...timestamps,
  },
  // ONE index, and it serves all three readers: the upsert arbiter, the daily
  // cap's exact `(environment, day)` lookup, and the promotion criteria's
  // "how many days has this tenant sent on" range scan — which is a prefix
  // scan on the same leading column. A second index on `environment_id` alone
  // would be a redundant copy of this one's prefix, paid for on every send.
  (table) => [
    uniqueIndex("email_daily_sends_environment_day_unique_idx").on(
      table.environmentId,
      table.day,
    ),
  ],
);
