"use client";

import { FieldStage } from "@/app/spike-daylight/dayfield-shared";
import { MATCHDAY_FIELD } from "@/app/spike-daylight/field-config";

/* ==========================================================================
 *  "Match day" — the field engine pointed at the World Cup final at MetLife.
 *  One stadium, relit and re-populated hour by hour (lights-off night with the
 *  city still lit → dawn → crowds → packed kick-off → full-time fireworks →
 *  litter-strewn aftermath), plus a Hogsend blimp over the daytime frames.
 *  Just the images + a scene label + the hidden day-arc. Maps to local time.
 * ========================================================================== */

export function MatchdayHero({
  initialHour,
  controls = true,
}: {
  initialHour?: number;
  controls?: boolean;
}) {
  return (
    <main className="relative h-[100svh] min-h-[720px] w-full overflow-hidden bg-[#050101] text-white">
      <FieldStage
        config={MATCHDAY_FIELD}
        variant="event"
        initialHour={initialHour}
        controls={controls}
      >
        <header className="dayfield-rise absolute inset-x-0 top-0 z-20">
          <div className="mx-auto max-w-[1256px] px-6 py-5 md:px-10">
            <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/70">
              <span className="text-[#f64838]">▲</span> World Cup Final ·
              MetLife Stadium
            </p>
          </div>
        </header>
      </FieldStage>
    </main>
  );
}
