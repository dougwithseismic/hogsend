import type { PostHogService } from "@hogsend/core";
import { createPostHogService } from "@hogsend/plugin-posthog";
import { getRedis } from "./redis.js";

let _posthog: PostHogService | undefined;

export function getPostHog(): PostHogService | undefined {
  if (!process.env.POSTHOG_API_KEY) return undefined;
  if (!_posthog) {
    _posthog = createPostHogService({
      apiKey: process.env.POSTHOG_API_KEY,
      host: process.env.POSTHOG_HOST,
      redis: getRedis(),
    });
  }
  return _posthog;
}
