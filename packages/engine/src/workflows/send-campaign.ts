import {
  bucketMemberships,
  campaigns,
  contacts,
  type Database,
  emailPreferences,
} from "@hogsend/db";
import type { TemplateName } from "@hogsend/email";
import { and, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
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

/** Statuses that are TERMINAL — a duplicate/late enqueue must not re-send. */
const TERMINAL_STATUSES = ["sent"] as const;

/**
 * Built-in durable campaign / broadcast task (Loops "campaign" parity). Sends a
 * single template to every subscribed member of a list (or every active member
 * of a bucket).
 *
 * Retry-safety: each send carries an idempotency key
 * `campaign:<campaignId>:<email>` (email_sends.idempotency_key, migration 0015),
 * so a Hatchet retry re-runs the whole loop but every already-dispatched send
 * short-circuits to its prior row instead of dispatching a duplicate provider
 * call. Counts are derived as-you-go from each `send()` result status — which is
 * itself idempotency-aware (a retried send returns the prior row's status), so
 * the tallies stay consistent across re-attempts. Final counts overwrite (not
 * increment) the row, so a retry re-derives them from scratch rather than
 * double-counting.
 *
 * Resume-on-retry: the terminal guard short-circuits ONLY a `sent` campaign — a
 * `failed`/`sending` row is NOT terminal, so a Hatchet retry (or the reaper's
 * re-enqueue) re-resolves the audience and re-loops. Already-dispatched sends
 * no-op via the idempotency key, so the re-run safely completes the TAIL of a
 * partial send instead of abandoning it. The catch block therefore does NOT
 * stamp `failed` before re-throwing — that would make the retry short-circuit
 * and silently under-deliver. A run that exhausts its retries is reaped to
 * `failed`/re-enqueued by {@link reapStuckCampaignsTask}.
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

    // Already terminal — a duplicate/late enqueue must not re-send. ONLY `sent`
    // is terminal: a `failed`/`sending` row is intentionally re-runnable so a
    // Hatchet retry (or a reaper re-enqueue) re-resolves the audience and
    // completes the unsent TAIL of a partial send (already-sent recipients
    // no-op via the per-send idempotency key — risk: silent under-delivery).
    if ((TERMINAL_STATUSES as readonly string[]).includes(campaign.status)) {
      return { status: campaign.status, skipped: true };
    }

    await db
      .update(campaigns)
      .set({ status: "sending", startedAt: new Date(), updatedAt: new Date() })
      .where(eq(campaigns.id, input.campaignId));

    let sentCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let totalRecipients = 0;

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
      const recipients =
        campaign.audienceKind === "bucket"
          ? resolveBucketRecipients(db, campaign.audienceId)
          : resolveListRecipients(db, campaign.audienceId);

      let chunk: CampaignRecipient[] = [];
      for await (const recipient of recipients) {
        chunk.push(recipient);
        if (chunk.length < CHUNK_SIZE) continue;
        await sendChunk();
      }
      // Final partial chunk.
      if (chunk.length > 0) await sendChunk();

      async function sendChunk(): Promise<void> {
        const batch = chunk;
        chunk = [];
        totalRecipients += batch.length;

        const results = await Promise.allSettled(
          batch.map((r) =>
            emailService.send({
              template: campaign?.templateKey as TemplateName,
              props: (campaign?.props ?? {}) as never,
              to: r.email,
              userId: r.userId,
              userEmail: r.email,
              subject: campaign?.subject ?? undefined,
              from: campaign?.fromEmail ?? undefined,
              // A list's audienceId IS a real subscription category, so pass it
              // through for suppression + the unsubscribe link. A bucket's
              // audienceId is NOT a category — forcing it here would mint an
              // unsubscribe link keyed on the bucket id (`categories[bucketId] =
              // false`) that the bucket resolver never honors (it only checks
              // unsubscribedAll/suppressed), silently no-op'ing the unsubscribe.
              // For a bucket, pass undefined so the template's OWN declared
              // category (e.g. `product-updates`) drives both suppression and a
              // real, honored List-Unsubscribe target.
              category:
                campaign?.audienceKind === "bucket"
                  ? undefined
                  : campaign?.audienceId,
              // The idempotency key dedupes a retried send to its prior row.
              idempotencyKey: `campaign:${input.campaignId}:${r.email}`,
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
            // as skipped, not a delivery failure.
            skippedCount++;
          }
        }

        await flushCounts();
      }

      await db
        .update(campaigns)
        .set({
          status: "sent",
          completedAt: new Date(),
          totalRecipients,
          sentCount,
          skippedCount,
          failedCount,
          updatedAt: new Date(),
        })
        .where(eq(campaigns.id, input.campaignId));

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
      // of a partial send. Instead we persist the progress counts, leave the
      // status `sending` (re-runnable), and re-throw so the genuine retry
      // re-enters the loop and finishes the unsent tail (already-sent recipients
      // no-op via their idempotency key). A run that EXHAUSTS its retries is
      // transitioned to `failed` (or re-enqueued) by `reapStuckCampaignsTask`.
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

      logger.error("send-campaign: errored mid-run (will retry)", {
        campaignId: input.campaignId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
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
 */
const GIVE_UP_AFTER_MS = Number(
  process.env.CAMPAIGN_GIVE_UP_AFTER_MS ?? 6 * 60 * 60 * 1000,
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

    // (1) Declare poison campaigns `failed` first (stuck past the give-up
    // window), so they are not re-enqueued below.
    const failedRows = await db
      .update(campaigns)
      .set({ status: "failed", completedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          inArray(campaigns.status, ["queued", "sending"]),
          lt(campaigns.updatedAt, giveUpBefore),
        ),
      )
      .returning({ id: campaigns.id });

    // (2) Re-enqueue stale-but-not-poison in-flight campaigns. The CAS bumps
    // `updatedAt` so the same row is not re-picked on the very next tick before
    // the re-driven run makes progress; the per-send idempotency key keeps the
    // re-enqueue safe even if the original run is somehow still alive.
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

    for (const row of staleRows) {
      try {
        await sendCampaignTask.run({ campaignId: row.id });
      } catch (err) {
        logger.warn("reap-stuck-campaigns: re-enqueue failed", {
          campaignId: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (failedRows.length > 0 || staleRows.length > 0) {
      logger.info("reap-stuck-campaigns: swept", {
        failed: failedRows.length,
        reEnqueued: staleRows.length,
      });
    }

    return {
      failed: failedRows.length,
      reEnqueued: staleRows.length,
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
