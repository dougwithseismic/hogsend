import type { VideoEmitter } from "./types.js";

/**
 * Adapt any `capture(event, properties)` function — structurally matches
 * `Hogsend["capture"]` from @hogsend/js (and PostHog's capture) without
 * importing either.
 */
export function createHogsendEmitter(opts: {
  capture: (event: string, properties?: Record<string, unknown>) => unknown;
}): VideoEmitter {
  return (event) => {
    opts.capture(event.name, event.properties);
  };
}
