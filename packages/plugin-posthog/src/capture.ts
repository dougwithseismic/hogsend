import type { PostHog } from "posthog-node";
import type { CaptureOptions } from "./types.js";

export function captureEvent(client: PostHog, opts: CaptureOptions): void {
  client.capture({
    distinctId: opts.distinctId,
    event: opts.event,
    properties: opts.properties,
  });
}
