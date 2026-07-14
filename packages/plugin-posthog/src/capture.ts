import type { PostHog } from "posthog-node";

export function captureEvent(opts: {
  client: PostHog;
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
  /** Group associations forwarded to PostHog as `$groups` on the event. */
  groups?: Record<string, string>;
}): void {
  opts.client.capture({
    distinctId: opts.distinctId,
    event: opts.event,
    properties: opts.properties,
    groups: opts.groups,
  });
}
