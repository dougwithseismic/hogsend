import type { Redis } from "ioredis";

export interface PostHogServiceConfig {
  apiKey: string;
  host?: string;
  redis?: Redis;
  cacheTtlSeconds?: number;
}

export interface PostHogService {
  getPersonProperties(distinctId: string): Promise<Record<string, unknown>>;

  captureEvent(opts: CaptureOptions): void;

  isFeatureEnabled(distinctId: string, flag: string): Promise<boolean>;

  shutdown(): Promise<void>;
}

export interface CaptureOptions {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
}

export interface PersonPropertiesConfig {
  apiKey: string;
  host: string;
}

export interface PersonPropertiesCache {
  redis: Redis;
  ttlSeconds: number;
}
