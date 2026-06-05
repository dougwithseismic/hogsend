import type { Redis } from "ioredis";

export interface PostHogServiceConfig {
  apiKey: string;
  host?: string;
  redis?: Redis;
  cacheTtlSeconds?: number;
}

// The analytics-provider contract now lives in the neutral @hogsend/core
// package. These re-exports keep every existing
// `import ... from "@hogsend/plugin-posthog"` working unchanged.
export type { CaptureOptions, PostHogService } from "@hogsend/core";

export interface PersonPropertiesConfig {
  apiKey: string;
  host: string;
}

export interface PersonPropertiesCache {
  redis: Redis;
  ttlSeconds: number;
}
