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
 * Multi-step campaigns (waves): when `steps` is non-NULL the row executes as a
 * sequence of set-operation waves separated by durable waits (see
 * `docs/campaign-steps-spec.md`); `currentStep` is the sole resume cursor and
 * `nextStepAt` mirrors `scheduledAt` for the pending wait. NULL `steps` =
 * legacy single-send row — behavior and per-send idempotency keys unchanged.
 *
 * `status` is a plain text column (not an enum) so adding a future state needs
 * no migration; the app constrains it to
 * `scheduled|queued|sending|waiting|sent|failed|canceled|expired`.
 *
 *  - `scheduled` — has a future `scheduledAt`; promoted to a live send by a
 *    Hatchet scheduled run (primary) or the reaper sweep (backstop)
 *  - `waiting` — a multi-step campaign between waves (pending wait elapses at
 *    `nextStepAt`). Non-terminal, cancelable, and deliberately NOT swept by
 *    the stale-`sending` re-enqueue (a 2-day wait is not a stuck campaign)
 *  - `canceled` — operator cancel (terminal); allowed from
 *    scheduled/queued/sending/waiting
 *  - `expired` — a code-defined campaign whose `sendAt` was already stale
 *    (past the grace window) when first reconciled — never sent (terminal)
 *
 * `audienceKind` + `audienceId` reference a code-defined list (ListRegistry) or
 * bucket (BucketRegistry) by string id — NOT a contacts FK, so there is no
 * relation to wire. The wave cohort lives in `campaign_recipients` (FK'd here).
 */
export const campaigns = pgTable(
  "campaigns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id"),
    name: text("name").notNull(),
    // scheduled | queued | sending | sent | failed | canceled | expired
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
     * Multi-step wave definition: `{ v: 1, steps: [...] }` — a versioned blob
     * (`v` is the forward-evolution seam for A/B splits etc.). NULL = legacy
     * single-send row (the top-level template/props/subject/from). The db
     * package cannot import @hogsend/core, so step elements are opaque here;
     * the engine narrows them to `CampaignStep` at read time.
     */
    steps: jsonb("steps").$type<{
      v: 1;
      steps: Array<Record<string, unknown>>;
    }>(),
    // The next step to execute — the sole resume cursor for the wave runtime.
    currentStep: integer("current_step").notNull().default(0),
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
    /**
     * Cumulative counts snapshot through the last COMPLETED wave — the resume
     * seed the current wave's flush-overwrite counters add onto. Required
     * because prior-wave counts are NOT ledger-derivable: suppressed sends
     * write no idempotency key and frequency-capped sends write NO
     * email_sends row at all. NULL for legacy single-send rows.
     */
    stepBaseCounts: jsonb("step_base_counts").$type<{
      total: number;
      sent: number;
      skipped: number;
      failed: number;
    }>(),
    /**
     * When a `scheduled` campaign becomes due. NULL for an immediate send.
     * The Hatchet scheduled run created at POST time is the punctual primary
     * trigger; the reaper cron promotes any due-but-unfired row as a backstop.
     */
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    /**
     * When a `waiting` campaign's pending wait elapses (set on
     * `sending → waiting`). Mirror of `scheduledAt`: the punctual Hatchet
     * scheduled run created at wait time is the primary trigger; the reaper's
     * promote/give-up sweeps for `waiting` rows key off this as the backstop.
     */
    nextStepAt: timestamp("next_step_at", { withTimezone: true }),
    /**
     * When the reaper's stale sweep FIRST found this in-flight
     * (`queued`/`sending`) row abandoned — set once (coalesce) on the first
     * re-enqueue, cleared back to NULL by every genuine progress flush of the
     * send task. The queued/sending give-up clause reads THIS, not
     * `updatedAt`: the sweep bumps `updatedAt` as its re-pick guard, so a
     * permanently-crashing row would otherwise never age past the give-up
     * window. NULL = not currently considered stale.
     */
    staleSince: timestamp("stale_since", { withTimezone: true }),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("campaigns_status_idx").on(table.status),
    index("campaigns_created_at_idx").on(table.createdAt),
    // The reaper's due-scheduled promotion sweep filters on both.
    index("campaigns_scheduled_at_idx").on(table.status, table.scheduledAt),
    // The reaper's `waiting` promote/give-up sweeps filter on both (mirror of
    // campaigns_scheduled_at_idx).
    index("campaigns_next_step_at_idx").on(table.status, table.nextStepAt),
    // Partial-unique on the client idempotency key (scoped to non-NULL keys so
    // the common keyless create is unconstrained). A retried create with the
    // same key collides here and resolves to the existing campaign.
    uniqueIndex("campaigns_idempotency_key_idx")
      .on(table.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
  ],
);
