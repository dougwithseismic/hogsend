import { days, defineBucket, sendEmail } from "@hogsend/engine";
import { Events, Templates } from "../journeys/constants/index.js";

// Lapsed-active: was active once, but has NOT done app.active in the last 7 days.
// The canonical dormancy predicate — the exists-ever leg excludes brand-new /
// never-active signups (who satisfy a bare not_exists trivially), while the
// windowed not_exists leg is the time-based flip the cron sweep owns (no event
// signals dormancy). reconcileJoins is intentionally UNSET: the engine infers it
// on for this absence-shaped composite, so the cron materializes the join when a
// once-active user crosses the 7-day window. fastExpiry on for near-instant
// winback eligibility.
export const wentDormant = defineBucket({
  meta: {
    id: "went-dormant",
    name: "Went dormant",
    enabled: true,
    timeBased: true,
    fastExpiry: true,
    criteria: (b) =>
      b.all(
        b.event(Events.APP_ACTIVE).exists(),
        b.event(Events.APP_ACTIVE).within(days(7)).notExists(),
      ),
  },
});

// Colocated reaction — the headline `dwell` capability. When a user has been
// CONTINUOUSLY in `went-dormant` for 30 days, send a final win-back. This
// desugars to a real durable journey owned by the bucket (grouped under it in
// Studio via `sourceBucketId`); `wentDormant.on(...)` returns the bucket, so it
// needs no separate registration — it ships with the bucket in `buckets/index`.
//
// Unlike `on("enter") + ctx.sleep(days(30))`, `dwell` is driven by the reconcile
// cron over the EXISTING active population and clocks off the backfill-derived
// historical anchor, so on first deploy it fires for people already long dormant
// rather than 30 days later. The handler gets the full `JourneyContext`;
// `ctx.dwellCount` is the elapsed-interval ordinal (1 for a one-shot `after`).
wentDormant.on("dwell", { after: days(30) }, async (user) => {
  await sendEmail({
    to: user.email,
    userId: user.id,
    journeyStateId: user.stateId,
    template: Templates.REACTIVATION_FINAL_NUDGE,
    subject: "Still here whenever you're ready",
    journeyName: user.journeyName,
  });
});
