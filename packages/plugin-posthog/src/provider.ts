import { type AnalyticsProvider, defineAnalyticsProvider } from "@hogsend/core";
import { captureEvent } from "./capture.js";
import { createPostHogClient, DEFAULT_HOST } from "./client.js";
import { getPersonProperties } from "./properties.js";
import type {
  PersonPropertiesCache,
  PersonPropertiesConfig,
  PostHogServiceConfig,
} from "./types.js";

/**
 * The PostHog implementation of the neutral `AnalyticsProvider` contract —
 * the reference implementation, the way `createResendProvider` is for email.
 *
 * Credential split (PostHog's design, not Hogsend's):
 * - **capture + person WRITES** use the public project key (`apiKey`) — person
 *   writes ride the capture pipeline as `$set`/`$set_once`, so propagation
 *   needs NO extra credential.
 * - **person READS** need `personalApiKey` (a personal API key scoped
 *   `person:read`) against the private API host. Without it,
 *   `capabilities.personReads` is false and reads soft-fail to `{}` — the
 *   engine falls back to contact properties for timezone resolution.
 */
export function createPostHogProvider(
  config: PostHogServiceConfig,
): AnalyticsProvider {
  const host = config.host ?? DEFAULT_HOST;
  const client = createPostHogClient({ apiKey: config.apiKey, host });

  const propsConfig: PersonPropertiesConfig = {
    personalApiKey: config.personalApiKey,
    host,
    privateHost: config.privateHost,
    projectId: config.projectId,
  };

  const propsCache: PersonPropertiesCache | undefined = config.redis
    ? { redis: config.redis, ttlSeconds: config.cacheTtlSeconds ?? 300 }
    : undefined;

  return defineAnalyticsProvider({
    meta: {
      id: "posthog",
      name: "PostHog",
      description:
        "PostHog capture + person reads/writes (reads need a personal API key).",
    },
    capabilities: {
      personReads: Boolean(config.personalApiKey),
      personWrites: true,
    },

    async getPersonProperties(distinctId: string) {
      return getPersonProperties({
        config: propsConfig,
        distinctId,
        cache: propsCache,
      });
    },

    async setPersonProperties({ distinctId, set, setOnce, unset }) {
      if (!set && !setOnce && !unset?.length) return;
      client.capture({
        distinctId,
        event: "$set",
        properties: {
          ...(set ? { $set: set } : {}),
          ...(setOnce ? { $set_once: setOnce } : {}),
          ...(unset?.length ? { $unset: unset } : {}),
        },
      });
    },

    capture(opts) {
      captureEvent({ client, ...opts });
    },

    async shutdown() {
      await client.shutdown();
    },
  });
}
