import { PostHog } from "posthog-node";

export const DEFAULT_HOST = "https://us.i.posthog.com";

export function createPostHogClient(apiKey: string, host?: string): PostHog {
  return new PostHog(apiKey, { host: host ?? DEFAULT_HOST });
}
