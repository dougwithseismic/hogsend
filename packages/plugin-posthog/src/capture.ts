import type { PostHog } from "posthog-node";

export function captureEvent(opts: {
  client: PostHog;
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
}): void {
  opts.client.capture({
    distinctId: opts.distinctId,
    event: opts.event,
    properties: opts.properties,
  });
}
