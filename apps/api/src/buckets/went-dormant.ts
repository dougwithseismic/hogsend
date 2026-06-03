import { defineBucket } from "@hogsend/engine";
import { Events } from "../journeys/constants/index.js";

// Absence — did NOT do app.active in the last 7 days. The canonical time-based
// leave: no event will ever signal it; the cron sweep owns it. fastExpiry on for
// near-instant winback eligibility.
export const wentDormant = defineBucket({
  meta: {
    id: "went-dormant",
    name: "Went dormant",
    enabled: true,
    timeBased: true,
    fastExpiry: true,
    criteria: {
      type: "event",
      eventName: Events.APP_ACTIVE,
      check: "not_exists",
      within: { hours: 24 * 7 }, // days(7)
    },
  },
});
