import type { Metadata } from "next";
import {
  fieldInitialHour,
  MATCHDAY_FIELD,
} from "@/app/spike-daylight/field-config";
import { MatchdayHero } from "./matchday-hero";

/**
 * Spike — "Match day."
 * The field engine applied to an event: the World Cup final at MetLife, one
 * stadium relit + re-populated hour by hour, synchronized to the stadium's
 * timezone so the arc is the same for everyone worldwide. Noindex.
 */
export const metadata: Metadata = {
  title: "Spike — match day",
  robots: { index: false, follow: false },
};

export default function SpikeMatchdayPage() {
  return (
    <MatchdayHero initialHour={fieldInitialHour(MATCHDAY_FIELD)} controls />
  );
}
