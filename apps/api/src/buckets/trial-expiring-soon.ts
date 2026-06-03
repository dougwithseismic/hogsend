import { defineBucket } from "@hogsend/engine";

// Property inclusion + exclusion — on trial, plan not yet upgraded. Pure
// property predicates → in-memory, real-time only, NOT time-based. The criteria
// leave fires the moment they convert (real-time); `maxDwell` is an
// unconditional backstop.
export const trialExpiringSoon = defineBucket({
  meta: {
    id: "trial-expiring-soon",
    name: "Trial expiring soon",
    enabled: true,
    reentry: "once",
    // Unconditional time-box: drop them 14 days after joining REGARDLESS of
    // whether they're still on a trial — stop the "expiring soon" nag eventually.
    // The reconcile cron force-leaves them; `reentry:"once"` keeps them out.
    maxDwell: { hours: 24 * 14 },
    criteria: {
      type: "composite",
      operator: "and",
      conditions: [
        { type: "property", property: "plan", operator: "eq", value: "trial" },
        {
          type: "property",
          property: "trial_days_left",
          operator: "lte",
          value: 3,
        },
        // exclusion: not already converted
        {
          type: "property",
          property: "converted",
          operator: "neq",
          value: true,
        },
      ],
    },
  },
});
