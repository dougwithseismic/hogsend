import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";
import { Events, Templates } from "./constants/index.js";

/**
 * Retention — Weekly activity digest.
 *
 * A ROLLING digest built on `ctx.digest`: the first `feature.used` enrolls the
 * user; every `feature.used` that lands during the 7-day window is absorbed by
 * the active-enrollment guard and collected at flush, so a busy week yields ONE
 * email instead of one per action. `entryLimit: "unlimited"` re-enrolls from
 * the next event after each window closes.
 */
export const retentionWeeklyDigest = defineJourney({
  meta: {
    id: "retention-weekly-digest",
    name: "Retention — Weekly activity digest",
    enabled: true,
    trigger: { event: Events.FEATURE_USED },
    entryLimit: "unlimited",
    // ctx.digest already collapses a whole week of activity into ONE send, so
    // the per-journey min-gap must be OFF: a suppress >= the digest window
    // would fight the rolling re-enrollment — each new window's send would be
    // gapped out against the previous window's and silently dropped.
    suppress: days(0),
    exitOn: [{ event: Events.USER_DELETED }],
  },

  run: async (user, ctx) => {
    // Collect a rolling 7-day window of `feature.used` into one execution. With
    // no explicit `event`/`where`, the digest defaults to this journey's
    // trigger event and applies its (empty) `trigger.where`.
    const digest = await ctx.digest({
      window: days(7),
      label: "weekly-activity",
    });
    await ctx.checkpoint("digest-flushed");

    // The 7-day window is a long wait and an unsubscribe does NOT exit the
    // journey, so re-check before sending (the documented long-wait rule).
    if (!(await ctx.guard.isSubscribed())) return;

    // "Batch" is plain TypeScript grouping over the digested events — group the
    // week's activity by feature name and turn each group into a stat row. The
    // digest primitive only collects and dedups the window; the batching is
    // yours.
    const byFeature = Object.groupBy(digest.events, (e) =>
      String(e.properties?.feature ?? "Other"),
    );
    const featureStats = Object.entries(byFeature).map(([feature, events]) => ({
      label: feature,
      value: String(events?.length ?? 0),
    }));

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.RETENTION_WEEKLY_DIGEST,
      subject: "Your Hogsend week",
      journeyName: user.journeyName,
      props: {
        periodLabel: "Last 7 days",
        stats: [
          { label: "Actions", value: String(digest.count) },
          ...featureStats,
        ],
      },
    });
  },
});
