import type { DurationObject } from "../duration.js";
import type {
  IfPast,
  TimeOfDayBuilder,
  Weekday,
  WhenBuilder,
} from "../types/journey-context.js";
import {
  resolveAfter,
  resolveNextLocalTime,
  resolveNextWeekday,
  resolveTomorrow,
} from "./resolvers.js";
import { isValidTimeZone } from "./tz.js";
import type { SendWindow } from "./window.js";

export interface CreateWhenBuilderOptions {
  timezone: string;
  window?: SendWindow;
  ifPast?: IfPast;
  /** Explicit clock source. It is read when a terminal resolver is called. */
  now: () => Date;
}

/**
 * Create the pure, timezone-bound builder used by both production journeys and
 * the zero-infrastructure test harness. The caller owns the clock; this module
 * never reads ambient time.
 */
export function createWhenBuilder(opts: CreateWhenBuilderOptions): WhenBuilder {
  const baseOpts = () => ({
    timezone: opts.timezone,
    now: opts.now(),
    window: opts.window,
    ifPast: opts.ifPast ?? ("next" as const),
  });

  const timeBuilder = (resolve: (time: string) => Date): TimeOfDayBuilder => ({
    at: (time) => resolve(time),
  });

  return {
    next(weekday: Weekday) {
      return timeBuilder((time) =>
        resolveNextWeekday(weekday, time, baseOpts()),
      );
    },
    nextLocal(time: string) {
      return resolveNextLocalTime(time, baseOpts());
    },
    tomorrow() {
      return timeBuilder((time) => resolveTomorrow(time, baseOpts()));
    },
    in(duration: DurationObject) {
      return timeBuilder((time) => resolveAfter(duration, time, baseOpts()));
    },
    tz(timezone: string) {
      if (!isValidTimeZone(timezone)) {
        throw new TypeError(`ctx.when.tz: invalid timezone "${timezone}"`);
      }
      return createWhenBuilder({ ...opts, timezone });
    },
    window(start: string, end: string) {
      return createWhenBuilder({ ...opts, window: { start, end } });
    },
    ifPast(strategy: IfPast) {
      return createWhenBuilder({ ...opts, ifPast: strategy });
    },
  };
}
