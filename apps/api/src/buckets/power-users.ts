import { defineBucket } from "@hogsend/engine";
import { Events } from "../journeys/constants/index.js";

// Behavioral inclusion — fired in 10+ times in the last 30 days. Time-based
// (rolling window) → swept by the reconcile cron for the absence leave.
export const powerUsers = defineBucket({
  meta: {
    id: "power-users",
    name: "Power users",
    description: "Performed a key action 10+ times in the last 30 days.",
    enabled: true,
    timeBased: true,
    reentry: "once_per_period",
    reentryPeriod: { hours: 24 * 7 },
    criteria: {
      type: "event",
      eventName: Events.KEY_ACTION,
      check: "count",
      operator: "gte",
      value: 10,
      within: { hours: 24 * 30 }, // days(30)
    },
  },
});
