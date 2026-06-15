import {
  type AnalyticsProvider,
  defineAnalyticsProvider,
  type IdentityMergeOptions,
} from "@hogsend/core";
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
 * - **person READS** need a privileged credential against the private API
 *   host: an engine-injected OAuth accessor (`authToken`, preferred) or
 *   `personalApiKey` (a personal API key scoped `person:read`, the fallback).
 *   With neither, `capabilities.personReads` is false and reads soft-fail to
 *   `{}` — the engine falls back to contact properties for timezone
 *   resolution.
 */
export function createPostHogProvider(
  config: PostHogServiceConfig,
): AnalyticsProvider {
  const host = config.host ?? DEFAULT_HOST;
  const client = createPostHogClient({ apiKey: config.apiKey, host });
  const authToken = config.authToken;

  const propsConfig: PersonPropertiesConfig = {
    personalApiKey: config.personalApiKey,
    getAuthToken: authToken ? () => authToken.getToken() : undefined,
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
      // LIVE getter: the container builds providers at BOOT, but the OAuth
      // credential can be stored at RUNTIME via `hogsend connect posthog`.
      // A getter means every reader (boot nudge, doctor, future Studio
      // status) sees current truth without rebuilding the provider.
      get personReads() {
        return (
          Boolean(config.personalApiKey) || (authToken?.isAvailable() ?? false)
        );
      },
      personWrites: true,
      oauth: true,
      // posthog-node exposes a native `alias` wire (anon-absorb merge).
      identityMerge: true,
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

    mergeIdentities({ distinctId, alias }: IdentityMergeOptions) {
      // Direction is load-bearing (MF-1): `distinctId` is the SURVIVING /
      // canonical (identified) id, `alias` the ABSORBED (anonymous) one — per
      // the PostHog DOCS, NOT the posthog-node `.d.ts` example, which shows it
      // backwards. The guard makes the Part-1 self-alias free and skips empties.
      if (!distinctId || !alias || distinctId === alias) return;
      // Fire-and-forget: rides the same async posthog-node queue as `capture`
      // (we deliberately do NOT await `aliasImmediate` on any hot path).
      client.alias({ distinctId, alias });
    },

    capture(opts) {
      captureEvent({ client, ...opts });
    },

    async shutdown() {
      await client.shutdown();
    },
  });
}
