import { type DurationObject, durationToMs } from "@hogsend/core";

/** Normalize any duration to a SINGLE-UNIT whole-seconds Go string ("120s")
 * before it reaches a Hatchet durable sleep (`sleepFor` or a `SleepCondition`).
 * The SDK renders ms numbers as multi-unit strings ("1m59s"), which some
 * hatchet-lite versions silently fail to honor as sleep conditions (the wait
 * resolves instantly with no match) — pinned empirically 2026-07-10. Whole
 * seconds match the SDK's own `sleepUntil` normalization. EVERY engine call
 * site that hands Hatchet a sleep duration must route through this — a raw ms
 * number reopens the instant-wake bug.
 *
 * Lives beside (not inside) `lib/hatchet.ts` because tests `vi.mock` that
 * module to stub the client singleton; this helper must survive the mock. */
export const toSleepDuration = (
  durationOrMs: DurationObject | number,
): `${number}s` => {
  const ms =
    typeof durationOrMs === "number"
      ? durationOrMs
      : durationToMs(durationOrMs);
  return `${Math.max(1, Math.ceil(ms / 1000))}s`;
};
