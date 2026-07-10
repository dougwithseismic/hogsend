import {
  type CampaignSendStep,
  type CampaignStep,
  type ConditionEval,
  durationToMs,
} from "@hogsend/core";
import {
  bucketMemberships,
  campaignRecipients,
  campaigns,
  contacts,
  type Database,
  emailPreferences,
} from "@hogsend/db";
import type { TemplateName } from "@hogsend/email";
import { and, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  cohortSuppressionSql,
  waveConditionSql,
} from "../campaigns/cohort-sql.js";
import { campaignSendKey } from "../lib/campaign-send-key.js";
import { normalizeEmail } from "../lib/contacts.js";
import { getDb } from "../lib/db.js";
import { getEmailService } from "../lib/email.js";
import { hatchet } from "../lib/hatchet.js";
import { createLogger } from "../lib/logger.js";
import { getListRegistry } from "../lists/registry-singleton.js";

/** Page size for resolving recipients + sending. */
const CHUNK_SIZE = 100;

/** A resolved recipient — every send needs at minimum an email. */
interface CampaignRecipient {
  email: string;
  userId?: string;
}

/**
 * Statuses that are TERMINAL — a duplicate/late enqueue must not re-send.
 * `canceled`/`expired` matter doubly for SCHEDULED (and now WAITING) campaigns:
 * the punctual Hatchet scheduled run cannot be deleted at cancel time (we don't
 * persist its id), so it still fires and must find the row terminal here and
 * no-op. `failed` is deliberately NOT terminal — a re-enqueue can revive it.
 */
const TERMINAL_STATUSES = ["sent", "canceled", "expired"] as const;

/**
 * How far ahead of `scheduledAt` / `nextStepAt` a run may fire and still
 * proceed (absorbs clock skew). An earlier fire — the punctual run created for
 * an instant that was later moved BACK (a reconcile edit for `scheduledAt`; a
 * reap + re-park re-schedule for `nextStepAt`) — skips without sending; the
 * run created for the new instant (or the reaper sweep) delivers it.
 */
const EARLY_FIRE_TOLERANCE_MS = 60 * 1000;

/**
 * Built-in durable campaign / broadcast task (Loops "campaign" parity). A
 * legacy row (NULL `steps`) sends a single template to every subscribed member
 * of a list (or every active member of a bucket). A multi-step row executes
 * its `steps` blob as WAVES — each send step a SET operation over the
 * campaign's anchored cohort, separated by durable waits (status `waiting`,
 * resumed at `nextStepAt`) — see docs/campaign-steps-spec.md §Wave runtime.
 * The task keeps its name and `{ campaignId }` input either way; the row's
 * `currentStep` is the sole resume cursor.
 *
 * Retry-safety: each send carries an idempotency key minted by
 * `campaignSendKey` — legacy `campaign:<id>:<email>` for single-step
 * campaigns, step-scoped `campaign:<id>:<step>:<email>` for EVERY step of a
 * multi-step campaign (email_sends.idempotency_key, migration 0015) — so a
 * Hatchet retry re-runs the wave but every already-dispatched send
 * short-circuits to its prior row instead of dispatching a duplicate provider
 * call. Counts are derived as-you-go from each `send()` result status — which
 * is itself idempotency-aware (a retried send returns the prior row's status),
 * so the tallies stay consistent across re-attempts.
 *
 * Counts across waves: the row counts are CUMULATIVE across waves.
 * `stepBaseCounts` snapshots the cumulative tallies through the last COMPLETED
 * wave (written with each cursor advance); the current wave always re-derives
 * its own tally from scratch on top of that seed, and every flush stays an
 * absolute overwrite — so a retried wave re-tallies exactly rather than
 * double-counting. Prior-wave counts are deliberately NOT derived from
 * `email_sends`: a suppressed send writes its row WITHOUT the idempotency key
 * and a frequency-capped send writes NO row at all, so the ledger cannot
 * reproduce skipped counts — hence the snapshot column.
 *
 * Resume-on-retry: the terminal guard short-circuits ONLY a terminal campaign —
 * a `failed`/`sending` row is NOT terminal, so a Hatchet retry (or the reaper's
 * re-enqueue) re-enters at `currentStep` and re-runs the current wave.
 * Already-dispatched sends no-op via the idempotency key, so the re-run safely
 * completes the TAIL of a partial wave instead of abandoning it. The catch
 * block therefore does NOT stamp `failed` before re-throwing — that would make
 * the retry short-circuit and silently under-deliver. A run that exhausts its
 * retries is reaped to `failed`/re-enqueued by {@link reapStuckCampaignsTask}.
 */
export const sendCampaignTask = hatchet.task({
  name: "send-campaign",
  // ONE durability re-attempt for a worker crash/timeout — the per-send
  // idempotency key makes a re-run safe (no double-send). Not a transient-retry
  // loop: the provider owns its own send backoff.
  retries: 1,
  executionTimeout: "600s",
  fn: async (input: { campaignId: string }) => {
    const db = getDb();
    const logger = createLogger(process.env.LOG_LEVEL ?? "info");
    const emailService = getEmailService();

    const rows = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, input.campaignId))
      .limit(1);
    const campaign = rows[0];
    if (!campaign) {
      logger.warn("send-campaign: campaign not found", {
        campaignId: input.campaignId,
      });
      return { status: "failed", reason: "not_found" as const };
    }

    // Already terminal — a duplicate/late enqueue must not re-send. ONLY
    // sent/canceled/expired are terminal: a `failed`/`sending` row is
    // intentionally re-runnable so a Hatchet retry (or a reaper re-enqueue)
    // re-enters at `currentStep` and completes the unsent TAIL of a partial
    // wave (already-sent recipients no-op via the per-send idempotency key —
    // risk: silent under-delivery).
    if ((TERMINAL_STATUSES as readonly string[]).includes(campaign.status)) {
      return { status: campaign.status, skipped: true };
    }

    // Early-fire guard: a `scheduled` campaign whose instant is still in the
    // future must not send. This is a stale punctual run — the `sendAt` was
    // moved later after this run was scheduled. The run for the new instant
    // (or the reaper's due-scheduled sweep) delivers it.
    if (
      campaign.status === "scheduled" &&
      campaign.scheduledAt &&
      campaign.scheduledAt.getTime() > Date.now() + EARLY_FIRE_TOLERANCE_MS
    ) {
      return { status: "scheduled", skipped: true, reason: "not_due" as const };
    }

    // Mirror clause for `waiting`: a punctual next-step run that fires while
    // `nextStepAt` is still in the future is stale — a reap + re-park replaced
    // the pending wait after this run was scheduled. The run created for the
    // new instant (or the reaper's waiting-promotion sweep) resumes it.
    if (
      campaign.status === "waiting" &&
      campaign.nextStepAt &&
      campaign.nextStepAt.getTime() > Date.now() + EARLY_FIRE_TOLERANCE_MS
    ) {
      return { status: "waiting", skipped: true, reason: "not_due" as const };
    }

    // Claim via CAS: only a non-terminal row transitions to `sending`, so a
    // cancel landing between the guard read above and this write is honored
    // rather than silently resurrected. `startedAt` is claimed ONCE
    // (coalesce): event-condition scoping reads "since campaign startedAt",
    // so a wave-2 claim must NOT reset the anchor wave-1's conditions were
    // already scoped by. The cursor + count seed are re-read FROM the claimed
    // row (not the pre-claim read) so a wave resumed after a crash sees the
    // exact state its predecessor persisted.
    const claimedRows = await db
      .update(campaigns)
      .set({
        status: "sending",
        startedAt: sql`coalesce(${campaigns.startedAt}, now())`,
        // A resumed `waiting` row's wait has elapsed — clear the stale instant
        // so serialized rows never show a countdown while `sending`. (Studio
        // keys its countdown on status === "waiting" regardless.)
        nextStepAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(campaigns.id, input.campaignId),
          inArray(campaigns.status, [
            "queued",
            "scheduled",
            "sending",
            "waiting",
          ]),
        ),
      )
      .returning({
        id: campaigns.id,
        currentStep: campaigns.currentStep,
        startedAt: campaigns.startedAt,
        stepBaseCounts: campaigns.stepBaseCounts,
      });
    const claim = claimedRows[0];
    if (!claim) {
      const current = await db
        .select({ status: campaigns.status })
        .from(campaigns)
        .where(eq(campaigns.id, input.campaignId))
        .limit(1);
      return { status: current[0]?.status ?? "unknown", skipped: true };
    }

    // The executable step sequence. A NULL blob is a legacy single-send row —
    // one send step synthesized from the row columns, and (per the
    // campaignSendKey contract) the LEGACY per-send key format. A non-NULL
    // blob only ever holds > 1 steps (the reconciler stores single-step
    // definitions as NULL), so `multiStep` doubles as the key-format switch:
    // step-scoped keys for ALL steps including 0.
    const blob = campaign.steps;
    const multiStep = blob != null;
    const executable: CampaignStep[] = blob
      ? // db cannot import @hogsend/core, so the blob's elements are opaque
        // Record<string, unknown> there; the engine owns the narrowing.
        (blob.steps as unknown as CampaignStep[])
      : [
          {
            kind: "send",
            template: campaign.templateKey,
            props: campaign.props ?? {},
            ...(campaign.subject != null ? { subject: campaign.subject } : {}),
            ...(campaign.fromEmail != null ? { from: campaign.fromEmail } : {}),
          },
        ];

    // Immutable row facts captured once (nested fns below can't see the
    // `campaign` narrowing). `startedAt` is non-null post-claim (coalesce);
    // the ?? is a type-level fallback only.
    const audienceKind = campaign.audienceKind;
    const audienceId = campaign.audienceId;
    const startedAt = claim.startedAt ?? new Date();

    // Seed the cumulative counters from the snapshot through the last
    // COMPLETED wave; the current wave re-derives its own tally on top. Do NOT
    // try to derive the seed from email_sends — suppressed sends write no
    // idempotency key and frequency-capped sends write no row (lib/tracked.ts).
    const base = claim.stepBaseCounts ?? {
      total: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
    };
    let totalRecipients = base.total;
    let sentCount = base.sent;
    let skippedCount = base.skipped;
    let failedCount = base.failed;

    const snapshotCounts = () => ({
      total: totalRecipients,
      sent: sentCount,
      skipped: skippedCount,
      failed: failedCount,
    });

    const flushCounts = async (): Promise<void> => {
      await db
        .update(campaigns)
        .set({
          totalRecipients,
          sentCount,
          skippedCount,
          failedCount,
          updatedAt: new Date(),
        })
        .where(eq(campaigns.id, input.campaignId));
    };

    try {
      // The wave loop: consecutive send steps run sequentially in this same
      // task run; a wait step parks the row (`waiting`) and returns. Resuming
      // with `currentStep` already past the last index (a crash between the
      // final cursor advance and the completion CAS) skips straight to the
      // completion CAS below — exactly right.
      for (let k = claim.currentStep; k < executable.length; k++) {
        const step = executable[k];
        if (step === undefined) break; // unreachable — loop bound

        if (step.kind === "wait") {
          const nextStepAt = new Date(Date.now() + durationToMs(step.duration));
          // Park CAS: only a still-`sending` row goes `waiting`, so a cancel
          // racing the end of the previous wave keeps its `canceled` status.
          // Cursor, wait instant, count snapshot, and counts land in ONE
          // update — a crash can never separate them.
          const parked = await db
            .update(campaigns)
            .set({
              status: "waiting",
              currentStep: k + 1,
              nextStepAt,
              stepBaseCounts: snapshotCounts(),
              totalRecipients,
              sentCount,
              skippedCount,
              failedCount,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(campaigns.id, input.campaignId),
                eq(campaigns.status, "sending"),
              ),
            )
            .returning({ id: campaigns.id });
          if (parked.length === 0) {
            await flushCounts();
            const current = await db
              .select({ status: campaigns.status })
              .from(campaigns)
              .where(eq(campaigns.id, input.campaignId))
              .limit(1);
            return { status: current[0]?.status ?? "unknown", skipped: true };
          }

          // Punctual resume run at nextStepAt — best-effort, same split as
          // `scheduledAt`: on failure the row stays `waiting` and the reaper's
          // waiting-promotion sweep resumes it.
          try {
            await sendCampaignTask.schedule(nextStepAt, {
              campaignId: input.campaignId,
            });
          } catch (err) {
            logger.warn(
              "send-campaign: next-step schedule failed (reaper will promote)",
              {
                campaignId: input.campaignId,
                nextStepAt: nextStepAt.toISOString(),
                error: err instanceof Error ? err.message : String(err),
              },
            );
          }

          logger.info("send-campaign: wave complete — waiting", {
            campaignId: input.campaignId,
            currentStep: k + 1,
            nextStepAt: nextStepAt.toISOString(),
          });
          return {
            status: "waiting" as const,
            currentStep: k + 1,
            nextStepAt: nextStepAt.toISOString(),
            totalRecipients,
            sentCount,
            skippedCount,
            failedCount,
          };
        }

        if (step.kind !== "send") {
          // A blob minted by a future engine (steps.v evolution) must fail
          // loudly here, not silently skip a delivery step.
          throw new Error(
            `send-campaign: unsupported step kind "${(step as { kind: string }).kind}" at step ${k} of campaign ${input.campaignId}`,
          );
        }

        const canceled = await runWave(k, step);
        if (canceled) {
          // The operator's cancel already stamped status/canceledAt; persist
          // the progress counts so the row shows how far the blast got.
          await flushCounts();
          logger.info("send-campaign: canceled mid-send", {
            campaignId: input.campaignId,
            currentStep: k,
            totalRecipients,
            sentCount,
            skippedCount,
            failedCount,
          });
          return {
            status: "canceled" as const,
            totalRecipients,
            sentCount,
            skippedCount,
            failedCount,
          };
        }

        // Advance the cursor + snapshot the cumulative counters in ONE update
        // — the wave is complete, so a retry entering after this point starts
        // at the NEXT step with these counts as its seed. Plain update (not
        // CAS): a cancel that raced the tail of the wave only bumps cursor
        // metadata on an already-terminal row, which nothing reads.
        await db
          .update(campaigns)
          .set({
            currentStep: k + 1,
            stepBaseCounts: snapshotCounts(),
            totalRecipients,
            sentCount,
            skippedCount,
            failedCount,
            updatedAt: new Date(),
          })
          .where(eq(campaigns.id, input.campaignId));
      }

      // Completion CAS: only a still-`sending` row is stamped `sent`, so a
      // cancel racing the final chunk (after its last per-chunk check) keeps
      // its `canceled` status instead of being overwritten. `nextStepAt` +
      // `stepBaseCounts` are nulled — a terminal row carries no pending wait
      // and no resume seed.
      const completed = await db
        .update(campaigns)
        .set({
          status: "sent",
          completedAt: new Date(),
          nextStepAt: null,
          stepBaseCounts: null,
          totalRecipients,
          sentCount,
          skippedCount,
          failedCount,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(campaigns.id, input.campaignId),
            eq(campaigns.status, "sending"),
          ),
        )
        .returning({ id: campaigns.id });
      if (completed.length === 0) {
        await flushCounts();
        const current = await db
          .select({ status: campaigns.status })
          .from(campaigns)
          .where(eq(campaigns.id, input.campaignId))
          .limit(1);
        const status = current[0]?.status ?? "unknown";
        logger.info("send-campaign: finished but row left `sending` first", {
          campaignId: input.campaignId,
          status,
        });
        return {
          status,
          totalRecipients,
          sentCount,
          skippedCount,
          failedCount,
        };
      }

      logger.info("send-campaign: complete", {
        campaignId: input.campaignId,
        totalRecipients,
        sentCount,
        skippedCount,
        failedCount,
      });

      return {
        status: "sent" as const,
        totalRecipients,
        sentCount,
        skippedCount,
        failedCount,
      };
    } catch (error) {
      // Do NOT stamp `failed` here. A `failed` stamp before the re-throw makes
      // the single Hatchet retry hit the terminal guard and short-circuit
      // WITHOUT sending the remaining recipients — silently abandoning the tail
      // of a partial wave. Instead we persist the progress counts, leave the
      // status `sending` (re-runnable — `currentStep` still points at the
      // interrupted wave and `stepBaseCounts` still seeds it), and re-throw so
      // the genuine retry re-enters the wave and finishes the unsent tail
      // (already-sent recipients no-op via their idempotency key). A run that
      // EXHAUSTS its retries is transitioned to `failed` (or re-enqueued) by
      // `reapStuckCampaignsTask`.
      await flushCounts();

      logger.error("send-campaign: errored mid-run (will retry)", {
        campaignId: input.campaignId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    /**
     * Execute one per-recipient email wave. Returns `true` when a mid-wave
     * cancel was detected (the caller flushes + returns; nothing after the
     * detecting chunk is dispatched).
     *
     * Qualifier source:
     *  - Wave 0 resolves the audience LIVE (list/bucket resolvers, fresh
     *    suppression pre-filter) and — for MULTI-step campaigns — ANCHORS the
     *    cohort: each chunk is batch-inserted into `campaign_recipients`
     *    BEFORE its sends are dispatched — a crash between insert and send is
     *    fine (the retry re-resolves and the (campaign_id, email) unique
     *    absorbs the replay). The audience is resolved exactly once per
     *    campaign: someone added to the list afterwards never receives step 3
     *    without step 1. A single-send campaign skips the ledger entirely (no
     *    later wave will read it — the legacy write path stays byte-identical).
     *  - Waves k > 0 qualify FROM the anchored cohort: `campaign_recipients`
     *    ∩ the step's `where` conditions ∩ a fresh suppression re-check
     *    (see resolveCohortRecipients — suppression is never snapshotted).
     */
    async function runWave(
      k: number,
      step: CampaignSendStep,
    ): Promise<boolean> {
      const recipients =
        k === 0
          ? audienceKind === "bucket"
            ? resolveBucketRecipients(db, audienceId)
            : resolveListRecipients(db, audienceId)
          : resolveCohortRecipients(db, {
              campaignId: input.campaignId,
              conditions: step.where,
              startedAt,
            });

      // Mid-flight cancel: re-checked once per chunk (one cheap SELECT per
      // CHUNK_SIZE sends) so `POST /v1/campaigns/:id/cancel` can stop a blast
      // that is already `sending` — recipients not yet dispatched are spared.
      let cancelDetected = false;

      let chunk: CampaignRecipient[] = [];
      for await (const recipient of recipients) {
        chunk.push(recipient);
        if (chunk.length < CHUNK_SIZE) continue;
        await sendChunk();
        if (cancelDetected) return true;
      }
      // Final partial chunk.
      if (chunk.length > 0 && !cancelDetected) await sendChunk();
      return cancelDetected;

      async function sendChunk(): Promise<void> {
        const statusRows = await db
          .select({ status: campaigns.status })
          .from(campaigns)
          .where(eq(campaigns.id, input.campaignId))
          .limit(1);
        if (statusRows[0]?.status === "canceled") {
          cancelDetected = true;
          chunk = [];
          return;
        }

        const batch = chunk;
        chunk = [];

        // Anchor the cohort BEFORE dispatching the chunk (wave 0 of a
        // MULTI-step campaign only — a single-send campaign has no later wave
        // to read the ledger, so skipping the insert keeps the legacy blast's
        // write path byte-identical). Emails are already normalized by the
        // resolvers, matching the table's (campaign_id, email) unique
        // keyspace.
        if (k === 0 && multiStep) {
          await db
            .insert(campaignRecipients)
            .values(
              batch.map((r) => ({
                campaignId: input.campaignId,
                userId: r.userId ?? null,
                email: r.email,
              })),
            )
            .onConflictDoNothing({
              target: [campaignRecipients.campaignId, campaignRecipients.email],
            });
        }

        totalRecipients += batch.length;

        const results = await Promise.allSettled(
          batch.map((r) =>
            emailService.send({
              template: step.template as TemplateName,
              props: (step.props ?? {}) as never,
              to: r.email,
              userId: r.userId,
              userEmail: r.email,
              subject: step.subject,
              from: step.from,
              // A list's audienceId IS a real subscription category, so pass it
              // through for suppression + the unsubscribe link. A bucket's
              // audienceId is NOT a category — forcing it here would mint an
              // unsubscribe link keyed on the bucket id (`categories[bucketId] =
              // false`) that the bucket resolver never honors (it only checks
              // unsubscribedAll/suppressed), silently no-op'ing the unsubscribe.
              // For a bucket, pass undefined so the template's OWN declared
              // category (e.g. `product-updates`) drives both suppression and a
              // real, honored List-Unsubscribe target. The rule applies to
              // EVERY wave, not just the first.
              category: audienceKind === "bucket" ? undefined : audienceId,
              // The idempotency key dedupes a retried send to its prior row.
              // Legacy format for single-step campaigns; step-scoped for every
              // step of a multi-step campaign (campaignSendKey contract).
              idempotencyKey: campaignSendKey(
                input.campaignId,
                r.email,
                multiStep ? k : undefined,
              ),
            }),
          ),
        );

        for (const result of results) {
          if (result.status === "rejected") {
            failedCount++;
            continue;
          }
          const status = result.value.status;
          if (status === "sent") {
            sentCount++;
          } else {
            // suppressed | unsubscribed | skipped (frequency-capped) — counted
            // as skipped, not a delivery failure. The member STAYS in the
            // cohort either way: a provider hiccup or a skipped wave is not an
            // exit, and suppression is re-checked fresh on every later wave.
            skippedCount++;
          }
        }

        await flushCounts();
      }
    }
  },
});

/**
 * How long a campaign may sit in a non-terminal in-flight state (`queued` /
 * `sending`) before the reaper treats it as STALE and re-drives it. Must be
 * comfortably longer than the send task's `executionTimeout` (600s) so a
 * legitimately long but still-running send is never re-enqueued underneath
 * itself; the per-send idempotency key makes an overlap harmless anyway.
 */
const STALE_AFTER_MS = Number(
  process.env.CAMPAIGN_STALE_AFTER_MS ?? 15 * 60 * 1000,
);

/**
 * After a campaign has sat in a non-terminal in-flight state this long (measured
 * from `updatedAt`, which the send task bumps on every progress flush) it is
 * declared `failed` rather than re-enqueued forever — a poison campaign (e.g. a
 * template that always throws) stops being re-driven and surfaces to operators.
 *
 * Known gap (pre-existing): the stale sweep's own re-enqueue CAS ALSO bumps
 * `updatedAt` (its re-pick guard), so a deterministically-crashing in-flight
 * row is re-bumped every cycle and its `updatedAt` never ages past this
 * window — the queued/sending give-up effectively cannot fire. `scheduled` /
 * `waiting` rows are unaffected (measured from `scheduledAt` / `nextStepAt`).
 * Fixing it needs a bump-free staleness marker (e.g. a `stale_since` column)
 * — a deliberate follow-up, not a waves change.
 */
const GIVE_UP_AFTER_MS = Number(
  process.env.CAMPAIGN_GIVE_UP_AFTER_MS ?? 6 * 60 * 60 * 1000,
);

/**
 * How far past `scheduledAt` a `scheduled` campaign (or past `nextStepAt` a
 * `waiting` one) may sit before the reaper promotes it (enqueues the send
 * task). The punctual Hatchet scheduled run created at schedule/park time is
 * the primary trigger; this grace keeps the sweep from routinely
 * double-firing right at the boundary. A double fire is harmless anyway
 * (terminal guard + per-send idempotency).
 */
const SCHEDULE_PROMOTE_GRACE_MS = Number(
  process.env.CAMPAIGN_PROMOTE_GRACE_MS ?? 2 * 60 * 1000,
);

/**
 * Engine-owned reaper cron for campaigns left in a non-terminal in-flight state
 * with no live run to finish them (closes the "stuck forever" gap):
 *
 *  - A `sending` campaign whose worker was hard-killed (OOM/SIGKILL/pod
 *    eviction) or whose run exceeded `executionTimeout` AFTER its retry — the JS
 *    catch never ran, so the row is stuck `sending` with no live run.
 *  - A `queued` campaign whose enqueue threw at create time (broker down /
 *    network) — the row was committed but no run was ever created (orphan).
 *  - A `scheduled` campaign whose punctual Hatchet scheduled run never fired
 *    (schedule-create failed at POST/reconcile time, or the run was lost) —
 *    promoted once `scheduledAt` is {@link SCHEDULE_PROMOTE_GRACE_MS} past
 *    due. A scheduled row stuck past the give-up window (measured from
 *    `scheduledAt`, NOT `updatedAt` — a row is legitimately idle between
 *    create and send time) is declared `failed`.
 *  - A `waiting` campaign whose punctual next-step run was lost — promoted
 *    once `nextStepAt` is past the same grace. Give-up is likewise measured
 *    from `nextStepAt`, NOT `updatedAt` — a row is legitimately idle mid-wait,
 *    exactly like `scheduled`/`scheduledAt`.
 *
 * Recovery is a simple RE-ENQUEUE of `sendCampaignTask` (safe: the per-send
 * idempotency key no-ops already-sent recipients and the re-run completes the
 * unsent tail). A campaign that stays stuck past `GIVE_UP_AFTER_MS` is declared
 * `failed` so it stops being re-driven and surfaces to operators.
 *
 * Self-bootstraps `db` (memoized `getDb()` singleton) / `logger` from
 * `process.env` (cron runs have no request container), cloned from
 * `bucket-reconcile.ts`. NON-cancelling single-flight concurrency so an
 * overrunning sweep finishes rather than being cancelled.
 */
export const reapStuckCampaignsTask = hatchet.task({
  name: "reap-stuck-campaigns",
  onCrons: [process.env.CAMPAIGN_REAPER_CRON ?? "*/5 * * * *"],
  retries: 1,
  executionTimeout: "120s",
  fn: async () => {
    const db = getDb();
    const logger = createLogger(process.env.LOG_LEVEL ?? "info");

    const now = Date.now();
    const staleBefore = new Date(now - STALE_AFTER_MS);
    const giveUpBefore = new Date(now - GIVE_UP_AFTER_MS);
    const promoteBefore = new Date(now - SCHEDULE_PROMOTE_GRACE_MS);

    // (1) Declare poison campaigns `failed` first (stuck past the give-up
    // window), so they are not re-enqueued below. In-flight rows are measured
    // from `updatedAt` (bumped on every progress flush); `scheduled` rows from
    // `scheduledAt` and `waiting` rows from `nextStepAt` (their `updatedAt` is
    // legitimately old while they wait).
    const failedRows = await db
      .update(campaigns)
      .set({ status: "failed", completedAt: new Date(), updatedAt: new Date() })
      .where(
        or(
          and(
            inArray(campaigns.status, ["queued", "sending"]),
            lt(campaigns.updatedAt, giveUpBefore),
          ),
          and(
            eq(campaigns.status, "scheduled"),
            lt(campaigns.scheduledAt, giveUpBefore),
          ),
          and(
            eq(campaigns.status, "waiting"),
            lt(campaigns.nextStepAt, giveUpBefore),
          ),
        ),
      )
      .returning({ id: campaigns.id });

    // (2) Re-enqueue stale-but-not-poison in-flight campaigns. The CAS bumps
    // `updatedAt` so the same row is not re-picked on the very next tick before
    // the re-driven run makes progress; the per-send idempotency key keeps the
    // re-enqueue safe even if the original run is somehow still alive.
    // `queued`/`sending` ONLY — `waiting` is deliberately excluded: a 2-day
    // wait between waves is not a stuck campaign (its resume path is the
    // promotion sweep below, keyed on `nextStepAt`).
    const staleRows = await db
      .update(campaigns)
      .set({ updatedAt: new Date() })
      .where(
        and(
          inArray(campaigns.status, ["queued", "sending"]),
          lt(campaigns.updatedAt, staleBefore),
        ),
      )
      .returning({ id: campaigns.id });

    // (3) Promote due `scheduled` campaigns whose punctual scheduled run never
    // fired, and due `waiting` campaigns whose punctual next-step run was lost.
    // Enqueue-only — the send task owns the scheduled/waiting→sending
    // transition, so a failed enqueue simply retries next sweep.
    const dueRows = await db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(
        or(
          and(
            eq(campaigns.status, "scheduled"),
            lte(campaigns.scheduledAt, promoteBefore),
          ),
          and(
            eq(campaigns.status, "waiting"),
            lte(campaigns.nextStepAt, promoteBefore),
          ),
        ),
      );

    // Enqueue WITHOUT waiting for results — `.run()` blocks until the whole
    // blast completes, which would serialize entire sends inside this cron's
    // 120s executionTimeout.
    for (const row of [...staleRows, ...dueRows]) {
      try {
        await sendCampaignTask.runNoWait({ campaignId: row.id });
      } catch (err) {
        logger.warn("reap-stuck-campaigns: re-enqueue failed", {
          campaignId: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (failedRows.length > 0 || staleRows.length > 0 || dueRows.length > 0) {
      logger.info("reap-stuck-campaigns: swept", {
        failed: failedRows.length,
        reEnqueued: staleRows.length,
        promoted: dueRows.length,
      });
    }

    return {
      failed: failedRows.length,
      reEnqueued: staleRows.length,
      promoted: dueRows.length,
    };
  },
});

/**
 * Single-sourced keyset-pagination control flow shared by every recipient
 * resolver. Owns the cursor lifecycle (init → page → empty/short-page break →
 * advance) so the paging invariants live in ONE place; each resolver supplies
 * only its `page(cursor)` query (which owns its own `where`/`orderBy`/`limit`),
 * a `cursorOf(row)` extractor for the keyset column, and a `map(row)` that turns
 * a row into a recipient (or `undefined` to skip it, e.g. a null email or an
 * opt-in row that isn't actually subscribed). Breaks on an empty page OR a page
 * shorter than `CHUNK_SIZE` (the last page), then advances to the last row's
 * cursor — bailing if that cursor is missing to avoid an infinite loop.
 */
async function* keysetPaginate<Row>(opts: {
  page: (cursor: string | undefined) => Promise<Row[]>;
  cursorOf: (row: Row) => string | undefined;
  map: (row: Row) => CampaignRecipient | undefined;
}): AsyncGenerator<CampaignRecipient> {
  let cursor: string | undefined;
  while (true) {
    const rows = await opts.page(cursor);
    if (rows.length === 0) break;

    for (const row of rows) {
      const recipient = opts.map(row);
      if (recipient) yield recipient;
    }

    if (rows.length < CHUNK_SIZE) break;
    cursor = opts.cursorOf(rows[rows.length - 1] as Row);
    if (!cursor) break;
  }
}

/**
 * Wave-k (k > 0) qualifier resolver: the campaign's anchored cohort
 * (`campaign_recipients`) ∩ the step's `where` conditions (each compiled to a
 * correlated [NOT] EXISTS — see `campaigns/cohort-sql.ts`) ∩ a fresh
 * suppression/unsubscribe re-check. Membership was anchored at wave 0 and is
 * never re-resolved — a member who left the bucket/list between waves still
 * qualifies (suppression excepted); a member added afterwards never appears.
 * Paged by the keyset cursor on `campaign_recipients.id` (the
 * (campaign_id, id) index), so every page is an indexed join, never a LIKE
 * scan over email_sends.
 */
async function* resolveCohortRecipients(
  db: Database,
  opts: {
    campaignId: string;
    conditions: ConditionEval[] | undefined;
    startedAt: Date;
  },
): AsyncGenerator<CampaignRecipient> {
  // Compiled once per wave — every page reuses the same predicates.
  const qualifiers = (opts.conditions ?? []).map((condition) =>
    waveConditionSql({
      condition,
      campaignId: opts.campaignId,
      startedAt: opts.startedAt,
    }),
  );

  yield* keysetPaginate({
    page: (cursor) => {
      const conditions = [
        eq(campaignRecipients.campaignId, opts.campaignId),
        cohortSuppressionSql(),
        ...qualifiers,
      ];
      if (cursor) conditions.push(gt(campaignRecipients.id, cursor));

      return db
        .select({
          id: campaignRecipients.id,
          userId: campaignRecipients.userId,
          email: campaignRecipients.email,
        })
        .from(campaignRecipients)
        .where(and(...conditions))
        .orderBy(campaignRecipients.id)
        .limit(CHUNK_SIZE);
    },
    cursorOf: (row) => row.id,
    // Cohort emails were normalized at anchor time; userId may be NULL for an
    // email-only member (kept — the mailer falls back the same way wave 0 did).
    map: (row) => ({ email: row.email, userId: row.userId ?? undefined }),
  });
}

/**
 * Active, non-deleted members of a bucket, joined to a live contact for the
 * email — mirrors the bucket-access member query. Paged by the keyset cursor on
 * `bucket_memberships.id`.
 *
 * Compliance: `bucket_memberships.userEmail` is written verbatim from the RAW
 * event payload on the realtime join path (un-normalized, unlike
 * `contacts.email`), so the recipient email is NORMALIZED (`normalizeEmail`)
 * before it is yielded — otherwise a mixed-case membership email
 * (`User@Example.com`) would not case-match its NORMALIZED `email_preferences`
 * row (`user@example.com`) and the mailer's case-sensitive suppression check
 * would MISS the row, leaking a marketing blast to a suppressed/unsubscribed
 * contact (CAN-SPAM/GDPR). Defense-in-depth: this resolver ALSO pre-filters
 * `unsubscribedAll`/`suppressed` at the audience layer (mirroring the list
 * resolver) via a LEFT JOIN to `email_preferences` on the NORMALIZED email, so
 * a globally-unsubscribed / suppressed bucket member is excluded up front
 * rather than relying solely on the per-send mailer check (which avoids a
 * wasted provider attempt + a `failed` email_sends row, and closes the gap if
 * the per-send check ever case-splits).
 */
async function* resolveBucketRecipients(
  db: Database,
  bucketId: string,
): AsyncGenerator<CampaignRecipient> {
  // The recipient's normalized email — the membership email may be mixed-case
  // (written verbatim from the raw event), the contact email is the fallback.
  const recipientEmail = sql<string>`lower(trim(coalesce(${bucketMemberships.userEmail}, ${contacts.email})))`;

  yield* keysetPaginate({
    page: (cursor) => {
      const conditions = [
        eq(bucketMemberships.bucketId, bucketId),
        eq(bucketMemberships.status, "active"),
        isNull(bucketMemberships.deletedAt),
        isNull(contacts.deletedAt),
        // Exclude globally-unsubscribed / suppressed members up front via a
        // correlated NOT EXISTS (an EXISTS subquery, NOT a JOIN, so a member
        // with two prefs rows sharing the email is not fanned out into
        // duplicate recipients). An absent prefs row matches nothing → the
        // member is included (subscribed-by-default), mirroring the list
        // resolver's stance. Keyed on lower(email) so a mixed-case membership
        // email still matches its normalized prefs row (CAN-SPAM/GDPR: see the
        // fn docstring).
        sql`not exists (
        select 1 from ${emailPreferences}
        where lower(${emailPreferences.email}) = ${recipientEmail}
          and (${emailPreferences.unsubscribedAll} = true
               or ${emailPreferences.suppressed} = true)
      )`,
      ];
      if (cursor) conditions.push(gt(bucketMemberships.id, cursor));

      return db
        .select({
          id: bucketMemberships.id,
          userId: bucketMemberships.userId,
          membershipEmail: bucketMemberships.userEmail,
          contactEmail: contacts.email,
        })
        .from(bucketMemberships)
        .innerJoin(contacts, eq(contacts.externalId, bucketMemberships.userId))
        .where(and(...conditions))
        .orderBy(bucketMemberships.id)
        .limit(CHUNK_SIZE);
    },
    cursorOf: (row) => row.id,
    map: (row) => {
      const raw = row.membershipEmail ?? row.contactEmail;
      if (!raw) return undefined;
      // Normalize so the recipient matches the normalized email_preferences
      // keyspace the mailer's suppression check queries (see fn docstring).
      return { email: normalizeEmail(raw), userId: row.userId };
    },
  });
}

/**
 * Subscribed recipients of a list. A list shares the
 * `email_preferences.categories` JSONB namespace, so subscription is the LOCKED
 * polarity rule (`ListRegistry.isSubscribed`). The resolution STRATEGY depends
 * on the list's default polarity so the audience matches that single source of
 * truth EXACTLY — the same rule the mailer's per-send suppression check applies:
 *
 *  - OPT-OUT list (`defaultOptIn: true`, e.g. a newsletter): a contact is
 *    subscribed UNLESS `categories[id] === false`. The audience is therefore
 *    "all contacts minus those who opted out", INCLUDING the common case of a
 *    contact with NO preferences row at all (subscribed by default). Scanning
 *    `email_preferences` alone would silently under-deliver to roughly only the
 *    subset that touched the preference center, so we resolve from `contacts`
 *    LEFT JOIN `email_preferences` and exclude opted-out / unsubscribed /
 *    suppressed rows.
 *
 *  - OPT-IN list (`defaultOptIn: false`, must explicitly join): a contact is
 *    subscribed only when `categories[id] === true` — an explicit membership
 *    signal is REQUIRED. The audience is exactly the `email_preferences` rows
 *    carrying that explicit `true`, so a `contacts`-wide scan would be both
 *    wasteful and wrong (it would reach contacts who never opted in). We scan
 *    `email_preferences` directly.
 *
 * Either way globally-unsubscribed (`unsubscribedAll`) and suppressed
 * (bounce/complaint) contacts are excluded up front — the mailer's own check
 * would catch them, but skipping here avoids a wasted send + a `failed`
 * email_sends row.
 */
async function* resolveListRecipients(
  db: Database,
  listId: string,
): AsyncGenerator<CampaignRecipient> {
  const listRegistry = getListRegistry();
  const subscribedByDefault = listRegistry.isSubscribedByDefault(listId);

  if (subscribedByDefault) {
    yield* resolveOptOutListRecipients(db, listId);
    return;
  }
  yield* resolveOptInListRecipients(db, listId);
}

/**
 * Opt-IN list resolver (`defaultOptIn: false`): an explicit `categories[id] ===
 * true` is required, so the `email_preferences` scan is both correct and the
 * narrowest possible audience. Paged by the keyset cursor on
 * `email_preferences.id`.
 */
async function* resolveOptInListRecipients(
  db: Database,
  listId: string,
): AsyncGenerator<CampaignRecipient> {
  const listRegistry = getListRegistry();
  yield* keysetPaginate({
    page: (cursor) => {
      const conditions = [
        eq(emailPreferences.unsubscribedAll, false),
        eq(emailPreferences.suppressed, false),
      ];
      if (cursor) conditions.push(gt(emailPreferences.id, cursor));

      return db
        .select({
          id: emailPreferences.id,
          userId: emailPreferences.userId,
          email: emailPreferences.email,
          categories: emailPreferences.categories,
        })
        .from(emailPreferences)
        .where(and(...conditions))
        .orderBy(emailPreferences.id)
        .limit(CHUNK_SIZE);
    },
    cursorOf: (row) => row.id,
    map: (row) => {
      const categories = (row.categories ?? {}) as Record<string, boolean>;
      if (!listRegistry.isSubscribed(categories, listId)) return undefined;
      return { email: normalizeEmail(row.email), userId: row.userId };
    },
  });
}

/**
 * Opt-OUT list resolver (`defaultOptIn: true`): the audience is every live
 * contact with an email MINUS those who explicitly opted out of this list, are
 * globally unsubscribed, or are suppressed. Resolved from `contacts` LEFT JOIN
 * `email_preferences` (a contact with NO prefs row is subscribed by default and
 * MUST be reachable), paged by the keyset cursor on `contacts.id`.
 */
async function* resolveOptOutListRecipients(
  db: Database,
  listId: string,
): AsyncGenerator<CampaignRecipient> {
  const contactEmail = sql<string>`lower(${contacts.email})`;
  yield* keysetPaginate({
    page: (cursor) => {
      const conditions = [
        isNull(contacts.deletedAt),
        sql`${contacts.email} is not null`,
        // Exclude opted-out / globally-unsubscribed / suppressed via a
        // correlated NOT EXISTS (an EXISTS subquery, NOT a JOIN, so a contact
        // whose email maps to multiple prefs rows is not fanned out into
        // duplicate recipients). An absent prefs row matches nothing → the
        // contact is included (subscribed by default — exactly the case the
        // prior email_preferences-only scan silently dropped). "Opted out" of
        // THIS list means categories[listId] === false.
        sql`not exists (
        select 1 from ${emailPreferences}
        where lower(${emailPreferences.email}) = ${contactEmail}
          and (${emailPreferences.unsubscribedAll} = true
               or ${emailPreferences.suppressed} = true
               or (${emailPreferences.categories} ->> ${listId})::boolean = false)
      )`,
      ];
      if (cursor) conditions.push(gt(contacts.id, cursor));

      return db
        .select({
          id: contacts.id,
          userId: contacts.externalId,
          contactId: contacts.id,
          email: contacts.email,
        })
        .from(contacts)
        .where(and(...conditions))
        .orderBy(contacts.id)
        .limit(CHUNK_SIZE);
    },
    cursorOf: (row) => row.id,
    map: (row) => {
      if (!row.email) return undefined;
      // The send identity key mirrors the email_sends user_id fallback
      // (externalId ?? contactId) so the per-recipient idempotency namespace +
      // unsubscribe token stay consistent for a contact with no external id.
      return {
        email: normalizeEmail(row.email),
        userId: row.userId ?? row.contactId,
      };
    },
  });
}
