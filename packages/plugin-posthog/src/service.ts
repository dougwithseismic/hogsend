import { captureEvent } from "./capture.js";
import { createPostHogClient, DEFAULT_HOST } from "./client.js";
import { getPersonProperties } from "./properties.js";
import type {
  CaptureOptions,
  PersonPropertiesCache,
  PersonPropertiesConfig,
  PostHogService,
  PostHogServiceConfig,
} from "./types.js";

export function createPostHogService(
  config: PostHogServiceConfig,
): PostHogService {
  const host = config.host ?? DEFAULT_HOST;
  const client = createPostHogClient({ apiKey: config.apiKey, host });

  const propsConfig: PersonPropertiesConfig = {
    apiKey: config.apiKey,
    host,
  };

  const propsCache: PersonPropertiesCache | undefined = config.redis
    ? { redis: config.redis, ttlSeconds: config.cacheTtlSeconds ?? 300 }
    : undefined;

  return {
    async getPersonProperties(distinctId: string) {
      return getPersonProperties({
        config: propsConfig,
        distinctId,
        cache: propsCache,
      });
    },

    captureEvent(opts: CaptureOptions) {
      captureEvent({ client, ...opts });
    },

    identify(distinctId: string, properties: Record<string, unknown>) {
      client.capture({
        distinctId,
        event: "$set",
        properties: { $set: properties },
      });
    },

    async isFeatureEnabled({
      distinctId,
      flag,
    }: {
      distinctId: string;
      flag: string;
    }) {
      const result = await client.isFeatureEnabled(flag, distinctId);
      return result ?? false;
    },

    async shutdown() {
      await client.shutdown();
    },
  };
}
