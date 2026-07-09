/**
 * Boot-time reconciler for code-defined campaigns ({@link defineCampaign}).
 *
 * Runs once at worker start (before the Hatchet listener blocks), mirroring
 * `enqueueBucketBackfills`: fire-and-forget, best-effort, never blocks or
 * crashes boot. For each definition it upserts the `campaigns` row keyed by
 * `campaign-def:<id>` (the definition idempotency key):
 *
 *  - No row yet + `sendAt` in the future → insert `scheduled` and create a
 *    Hatchet scheduled run at `sendAt` (punctual primary; the reaper's
 *    due-scheduled sweep is the backstop if the schedule call fails).
 *  - No row yet + `sendAt` recently due (within {@link defineGraceMs}) → the
 *    deploy simply landed a beat after the send time; insert + enqueue now.
 *  - No row yet + `sendAt` stale (past the grace window) → insert `expired`
 *    and warn loudly. A late deploy NEVER fires a surprise blast; bump
 *    `sendAt` (or delete the file) to resolve.
 *  - Row exists and is still `scheduled` → sync mutable fields (name,
 *    audience, template, props, subject, from, sendAt) so editing the file and
 *    redeploying updates the pending broadcast — the git-ops loop. A moved
 *    `sendAt` gets a fresh scheduled run; the stale run no-ops via the send
 *    task's early-fire guard.
 *  - Row exists in any other status (`sent`/`canceled`/`expired`/`failed`/
 *    in-flight) → no-op. `sent` is the natural "retired" end state; an
 *    operator `canceled` is never resurrected by a redeploy.
 */
import { campaigns } from "@hogsend/db";
import { getTemplateNames } from "@hogsend/email";
import { and, eq, sql } from "drizzle-orm";
import type { HogsendClient } from "../container.js";
import { sendCampaignTask } from "../workflows/send-campaign.js";
import {
  audienceOf,
  DEFINED_CAMPAIGN_KEY_PREFIX,
  type DefinedCampaign,
} from "./define-campaign.js";

/**
 * How far past its `sendAt` a NEVER-SEEN definition may be and still send at
 * first reconcile (covers a deploy that lands minutes after the scheduled
 * instant). Anything staler is stamped `expired` instead — a definition
 * committed with last week's date must not blast on deploy.
 */
function defineGraceMs(): number {
  return Number(process.env.CAMPAIGN_DEFINE_GRACE_MS ?? 60 * 60 * 1000);
}

export interface ReconcileResult {
  created: number;
  updated: number;
  expired: number;
  skipped: number;
}

export async function reconcileDefinedCampaigns(opts: {
  client: HogsendClient;
  campaigns: DefinedCampaign[];
}): Promise<ReconcileResult> {
  const { client } = opts;
  const { db, logger, listRegistry, bucketRegistry, templates } = client;
  const result: ReconcileResult = {
    created: 0,
    updated: 0,
    expired: 0,
    skipped: 0,
  };

  const templateNames = new Set<string>(getTemplateNames(templates));
  const seenIds = new Set<string>();

  for (const campaign of opts.campaigns) {
    const meta = campaign.meta;
    if (seenIds.has(meta.id)) {
      logger.error("campaigns: duplicate defineCampaign id — skipping", {
        campaignId: meta.id,
      });
      result.skipped++;
      continue;
    }
    seenIds.add(meta.id);

    if (!meta.enabled) {
      result.skipped++;
      continue;
    }

    // Validate against the wired registries (same checks POST /v1/campaigns
    // applies). Warn + skip rather than throw: one broken definition must not
    // take down worker boot for every journey.
    const { audienceKind, audienceId } = audienceOf(meta);
    const audienceKnown =
      audienceKind === "list"
        ? listRegistry.has(audienceId)
        : bucketRegistry.has(audienceId);
    if (!audienceKnown) {
      logger.error("campaigns: unknown audience — skipping definition", {
        campaignId: meta.id,
        audienceKind,
        audienceId,
      });
      result.skipped++;
      continue;
    }
    if (!templateNames.has(meta.template)) {
      logger.error("campaigns: unknown template — skipping definition", {
        campaignId: meta.id,
        template: meta.template,
      });
      result.skipped++;
      continue;
    }

    const idempotencyKey = `${DEFINED_CAMPAIGN_KEY_PREFIX}${meta.id}`;
    const existingRows = await db
      .select({
        id: campaigns.id,
        status: campaigns.status,
        name: campaigns.name,
        audienceKind: campaigns.audienceKind,
        audienceId: campaigns.audienceId,
        templateKey: campaigns.templateKey,
        props: campaigns.props,
        fromEmail: campaigns.fromEmail,
        subject: campaigns.subject,
        scheduledAt: campaigns.scheduledAt,
      })
      .from(campaigns)
      .where(eq(campaigns.idempotencyKey, idempotencyKey))
      .limit(1);
    const existing = existingRows[0];

    const now = Date.now();
    const due = meta.sendAt.getTime() <= now;
    const stale = meta.sendAt.getTime() < now - defineGraceMs();

    if (!existing) {
      if (stale) {
        await db.insert(campaigns).values({
          name: meta.name,
          status: "expired",
          audienceKind,
          audienceId,
          templateKey: meta.template,
          props: meta.props ?? {},
          fromEmail: meta.from ?? null,
          subject: meta.subject ?? null,
          scheduledAt: meta.sendAt,
          idempotencyKey,
        });
        logger.warn(
          "campaigns: defined campaign sendAt is stale — marked expired, NOT sent",
          {
            campaignId: meta.id,
            sendAt: meta.sendAt.toISOString(),
            graceMs: defineGraceMs(),
          },
        );
        result.expired++;
        continue;
      }

      const inserted = await db
        .insert(campaigns)
        .values({
          name: meta.name,
          status: "scheduled",
          audienceKind,
          audienceId,
          templateKey: meta.template,
          props: meta.props ?? {},
          fromEmail: meta.from ?? null,
          subject: meta.subject ?? null,
          scheduledAt: meta.sendAt,
          idempotencyKey,
        })
        // Two worker replicas reconciling concurrently: the loser of the
        // partial-unique insert race simply defers to the winner's row. The
        // `targetWhere` predicate must match the PARTIAL unique index
        // (`WHERE idempotency_key IS NOT NULL`) or Postgres cannot infer the
        // conflict arbiter (42P10).
        .onConflictDoNothing({
          target: campaigns.idempotencyKey,
          where: sql`idempotency_key is not null`,
        })
        .returning({ id: campaigns.id });
      const rowId = inserted[0]?.id;
      if (!rowId) {
        result.skipped++;
        continue;
      }

      await scheduleOrEnqueue({ client, rowId, sendAt: meta.sendAt, due });
      logger.info("campaigns: defined campaign scheduled", {
        campaignId: meta.id,
        rowId,
        sendAt: meta.sendAt.toISOString(),
      });
      result.created++;
      continue;
    }

    if (existing.status !== "scheduled") {
      // sent (retired) / canceled / expired / failed / in-flight — the row is
      // the source of truth once it has left `scheduled`.
      result.skipped++;
      continue;
    }

    const changed =
      existing.name !== meta.name ||
      existing.audienceKind !== audienceKind ||
      existing.audienceId !== audienceId ||
      existing.templateKey !== meta.template ||
      JSON.stringify(existing.props ?? {}) !==
        JSON.stringify(meta.props ?? {}) ||
      (existing.fromEmail ?? null) !== (meta.from ?? null) ||
      (existing.subject ?? null) !== (meta.subject ?? null) ||
      existing.scheduledAt?.getTime() !== meta.sendAt.getTime();

    if (!changed) {
      result.skipped++;
      continue;
    }

    const sendAtMoved =
      existing.scheduledAt?.getTime() !== meta.sendAt.getTime();

    // CAS on `scheduled` so an edit never clobbers a row that went live (or
    // was canceled) between the read above and this write.
    const updated = await db
      .update(campaigns)
      .set({
        name: meta.name,
        audienceKind,
        audienceId,
        templateKey: meta.template,
        props: meta.props ?? {},
        fromEmail: meta.from ?? null,
        subject: meta.subject ?? null,
        scheduledAt: meta.sendAt,
        updatedAt: new Date(),
      })
      .where(
        and(eq(campaigns.id, existing.id), eq(campaigns.status, "scheduled")),
      )
      .returning({ id: campaigns.id });

    if (updated.length > 0 && sendAtMoved) {
      // Fresh run at the new instant; the run created for the OLD instant
      // finds `scheduledAt` still in the future when it fires and skips
      // (send task early-fire guard), or finds the row terminal.
      await scheduleOrEnqueue({
        client,
        rowId: existing.id,
        sendAt: meta.sendAt,
        due,
      });
    }
    logger.info("campaigns: defined campaign updated", {
      campaignId: meta.id,
      rowId: existing.id,
      sendAt: meta.sendAt.toISOString(),
    });
    result.updated++;
  }

  return result;
}

/**
 * Create the punctual trigger for a scheduled row: a Hatchet scheduled run at
 * `sendAt`, or an immediate enqueue when already due (within grace).
 * Best-effort — on failure the row stays `scheduled` and the reaper's
 * due-scheduled sweep promotes it.
 */
async function scheduleOrEnqueue(opts: {
  client: HogsendClient;
  rowId: string;
  sendAt: Date;
  due: boolean;
}): Promise<void> {
  const { client, rowId, sendAt, due } = opts;
  try {
    if (due) {
      await sendCampaignTask.runNoWait({ campaignId: rowId });
    } else {
      await sendCampaignTask.schedule(sendAt, { campaignId: rowId });
    }
  } catch (err) {
    client.logger.warn(
      "campaigns: schedule/enqueue failed (reaper will promote)",
      {
        rowId,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }
}
