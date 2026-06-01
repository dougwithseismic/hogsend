import type { SendWindow } from "@hogsend/core/schedule";

/**
 * The scheduling-relevant slice of the client `defaults`, set once by
 * `createHogsendClient` and read by the module-level journey task in
 * `define-journey` (which has no client reference of its own). Frequency-cap
 * config is threaded through the mailer, not here.
 */
export interface ClientScheduleDefaults {
  timezone: string;
  sendWindow?: SendWindow;
}

let _defaults: ClientScheduleDefaults = { timezone: "UTC" };

export function setClientScheduleDefaults(
  defaults: ClientScheduleDefaults,
): void {
  _defaults = defaults;
}

export function getClientScheduleDefaults(): ClientScheduleDefaults {
  return _defaults;
}

/** Reset to the UTC default — only for test cleanup. */
export function resetClientScheduleDefaults(): void {
  _defaults = { timezone: "UTC" };
}
