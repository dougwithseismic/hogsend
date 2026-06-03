import { days, defineBucket } from "@hogsend/engine";
import { Events } from "../journeys/constants/index.js";

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
