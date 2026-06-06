import { days } from "@hogsend/core";
import { defineBucket } from "@hogsend/engine";
import { Events } from "../journeys/constants/index.js";

// Behavioral inclusion — performed key.action 10+ times in the last 30 days.
// Time-based (rolling window) → swept by the reconcile cron when the windowed
// count decays below the threshold. Authored with the fluent criteria builder;
// it compiles to the same ConditionEval the declarative form would produce.
export const powerUsers = defineBucket({
  meta: {
    id: "power-users",
    name: "Power users",
    description: "Performed a key action 10+ times in the last 30 days.",
    enabled: true,
    timeBased: true,
    entryLimit: "once_per_period",
    entryPeriod: days(7),
    criteria: (b) => b.event(Events.KEY_ACTION).within(days(30)).atLeast(10),
  },
});
