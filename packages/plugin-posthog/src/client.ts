import { PostHog } from "posthog-node";

export const DEFAULT_HOST = "https://us.i.posthog.com";

export function createPostHogClient(opts: {
  apiKey: string;
  host?: string;
}): PostHog {
  return new PostHog(opts.apiKey, { host: opts.host ?? DEFAULT_HOST });
}
