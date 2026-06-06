import { days, defineBucket } from "@hogsend/engine";

// Property inclusion + exclusion — on trial, plan not yet upgraded. Pure
// property predicates → in-memory, real-time only, NOT time-based. The criteria
// leave fires the moment they convert (real-time); `maxDwell` is an
// unconditional backstop.
export const trialExpiringSoon = defineBucket({
  meta: {
    id: "trial-expiring-soon",
    name: "Trial expiring soon",
    enabled: true,
    entryLimit: "once",
    // Unconditional time-box: drop them 14 days after joining REGARDLESS of
    // whether they're still on a trial — stop the "expiring soon" nag eventually.
    // The reconcile cron force-leaves them; `entryLimit:"once"` keeps them out.
    maxDwell: days(14),
    criteria: (b) =>
      b.all(
        b.prop("plan").eq("trial"),
        b.prop("trial_days_left").lte(3),
        // exclusion: not already converted
        b.prop("converted").neq(true),
      ),
  },
});
