import { defineBucket } from "@hogsend/engine";

// Property inclusion + exclusion — on trial, plan not yet upgraded. Pure
// property predicates → in-memory, real-time only, NOT time-based.
export const trialExpiringSoon = defineBucket({
  meta: {
    id: "trial-expiring-soon",
    name: "Trial expiring soon",
    enabled: true,
    reentry: "once",
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
