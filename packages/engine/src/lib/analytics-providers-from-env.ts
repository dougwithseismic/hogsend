import type { AnalyticsProvider } from "@hogsend/core";
import { createPostHogProvider } from "@hogsend/plugin-posthog";
import type { env as envSchema } from "../env.js";
import { getRedis } from "./redis.js";

/**
 * Env-driven analytics-provider presets — the analytics sibling of
 * `emailProvidersFromEnv`. PostHog is built when `POSTHOG_API_KEY` is set;
 * person READS additionally need `POSTHOG_PERSONAL_API_KEY` (the public phc_
 * key is write-only by PostHog's design) — without it the provider still
 * captures and writes person properties, and reads soft-fail to the engine's
 * contact-property fallback.
 *
 * Consumer-supplied providers (`analytics.providers` / `analytics.provider`)
 * merge AFTER these in the registry, so a consumer build of the same id wins.
 */
export function analyticsProvidersFromEnv(
  env: typeof envSchema,
): AnalyticsProvider[] {
  const providers: AnalyticsProvider[] = [];

  if (env.POSTHOG_API_KEY) {
    providers.push(
      createPostHogProvider({
        apiKey: env.POSTHOG_API_KEY,
        host: env.POSTHOG_HOST,
        personalApiKey: env.POSTHOG_PERSONAL_API_KEY,
        projectId: env.POSTHOG_PROJECT_ID,
        privateHost: env.POSTHOG_PRIVATE_HOST,
        redis: getRedis(),
      }),
    );
  }

  return providers;
}
