import type { PostHogService } from "@hogsend/core";
import { createPostHogService } from "@hogsend/plugin-posthog";
import { getRedis } from "./redis.js";

let _posthog: PostHogService | undefined;

/**
 * Lazy PostHog service singleton for STANDALONE consumer imports (journeys
 * calling `getPostHog()` for capture/identify/flags). Reads process.env
 * directly so it works without a container reference.
 *
 * Person READS additionally require `POSTHOG_PERSONAL_API_KEY` (the phc_
 * project key is write-only by PostHog's design); without it
 * `getPersonProperties` soft-fails to `{}`.
 *
 * The engine's own analytics path now flows through the neutral
 * `AnalyticsProvider` registry (see `analyticsProvidersFromEnv` /
 * `createHogsendClient`'s `analytics` option) — this stays for consumer code.
 */
export function getPostHog(): PostHogService | undefined {
  if (!process.env.POSTHOG_API_KEY) return undefined;
  if (!_posthog) {
    _posthog = createPostHogService({
      apiKey: process.env.POSTHOG_API_KEY,
      host: process.env.POSTHOG_HOST,
      personalApiKey: process.env.POSTHOG_PERSONAL_API_KEY,
      projectId: process.env.POSTHOG_PROJECT_ID,
      privateHost: process.env.POSTHOG_PRIVATE_HOST,
      redis: getRedis(),
    });
  }
  return _posthog;
}
