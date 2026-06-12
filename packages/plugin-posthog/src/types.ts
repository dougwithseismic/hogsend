import type { Redis } from "ioredis";

export interface PostHogServiceConfig {
  /** Project API key (`phc_…`) — capture/flags. Public + WRITE-ONLY by design. */
  apiKey: string;
  /** Capture/ingestion host, e.g. `https://eu.i.posthog.com`. */
  host?: string;
  /**
   * Personal API key (scoped `person:read`; add `person:write` for future
   * private-API writes). Person READS are disabled without it: the `phc_`
   * project key cannot read the private API — it ships in every browser
   * bundle, so PostHog makes it write-only (otherwise anyone could dump your
   * persons). See the "Analytics access" docs page.
   */
  personalApiKey?: string;
  /**
   * Private (app) API host. Defaults to the capture host with the `.i.`
   * ingestion label stripped (`eu.i.posthog.com` → `eu.posthog.com`).
   * Self-hosted instances usually serve both on one host — set explicitly
   * if yours differs.
   */
  privateHost?: string;
  /**
   * PostHog project id for the environment-scoped private endpoints. When
   * absent it is discovered once via `GET /api/projects/@current/` with the
   * personal key, then cached for the process lifetime.
   */
  projectId?: string;
  redis?: Redis;
  cacheTtlSeconds?: number;
}

// The analytics-provider contract now lives in the neutral @hogsend/core
// package. These re-exports keep every existing
// `import ... from "@hogsend/plugin-posthog"` working unchanged.
export type {
  AnalyticsProvider,
  CaptureOptions,
  PersonPropertiesWrite,
  PostHogService,
} from "@hogsend/core";

export interface PersonPropertiesConfig {
  /** Personal API key — reads are DISABLED (soft-fail `{}`) without it. */
  personalApiKey?: string;
  /** Capture/ingestion host (private host is derived from it). */
  host: string;
  /** Private API host override. */
  privateHost?: string;
  /** Project id override (skips `@current` discovery). */
  projectId?: string;
}

export interface PersonPropertiesCache {
  redis: Redis;
  ttlSeconds: number;
}
