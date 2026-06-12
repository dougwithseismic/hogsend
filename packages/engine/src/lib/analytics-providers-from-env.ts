import type { AnalyticsProvider } from "@hogsend/core";
import type { Database } from "@hogsend/db";
import {
  createPostHogProvider,
  type PostHogAuthTokenAccessor,
} from "@hogsend/plugin-posthog";
import type { env as envSchema } from "../env.js";
import type { Logger } from "./logger.js";
import { createTokenManager } from "./oauth-token-manager.js";
import { getRedis } from "./redis.js";

/**
 * Env-driven analytics-provider presets — the analytics sibling of
 * `emailProvidersFromEnv`. PostHog is built when `POSTHOG_API_KEY` is set;
 * person READS additionally need a privileged credential: an OAuth credential
 * stored via `hogsend connect posthog` (preferred, token-manager-backed) or
 * `POSTHOG_PERSONAL_API_KEY` (the public phc_ key is write-only by PostHog's
 * design) — without either the provider still captures and writes person
 * properties, and reads soft-fail to the engine's contact-property fallback.
 *
 * Consumer-supplied providers (`analytics.providers` / `analytics.provider`)
 * merge AFTER these in the registry, so a consumer build of the same id wins.
 */
export function analyticsProvidersFromEnv(
  env: typeof envSchema,
  deps?: { db?: Database; logger?: Logger },
): AnalyticsProvider[] {
  const providers: AnalyticsProvider[] = [];

  if (env.POSTHOG_API_KEY) {
    // Token-manager-backed accessor: the manager re-checks the DB (30s
    // negative cache), so a credential stored at RUNTIME via
    // `hogsend connect posthog` comes alive without a restart.
    let authToken: PostHogAuthTokenAccessor | undefined;
    if (deps?.db) {
      const tokenManager = createTokenManager({
        db: deps.db,
        providerId: "posthog",
        logger: deps.logger,
      });
      // Load-only warm-up (no refresh, never blocks construction). The
      // person-reads nudge logs HERE, after the load settles — the container
      // can't log it truthfully at boot because capabilities resolve async
      // for OAuth-capable providers (a connected instance would otherwise
      // log "DISABLED" once on every boot).
      const personalKeySet = Boolean(env.POSTHOG_PERSONAL_API_KEY);
      void tokenManager
        .prime()
        .then(() => {
          if (!personalKeySet && tokenManager.credentialState() !== "present") {
            deps.logger?.info(
              'analytics provider "posthog" has person reads DISABLED — ' +
                "timezone resolution falls back to contact properties. Set " +
                "POSTHOG_PERSONAL_API_KEY or run `hogsend connect posthog`. " +
                "Docs: https://hogsend.com/docs/guides/analytics-access",
            );
          }
        })
        .catch(() => {});
      authToken = {
        getToken: () => tokenManager.getAccessToken(),
        isAvailable: () => tokenManager.credentialState() === "present",
      };
    }
    providers.push(
      createPostHogProvider({
        apiKey: env.POSTHOG_API_KEY,
        host: env.POSTHOG_HOST,
        personalApiKey: env.POSTHOG_PERSONAL_API_KEY,
        projectId: env.POSTHOG_PROJECT_ID,
        privateHost: env.POSTHOG_PRIVATE_HOST,
        redis: getRedis(),
        authToken,
      }),
    );
  }

  return providers;
}
