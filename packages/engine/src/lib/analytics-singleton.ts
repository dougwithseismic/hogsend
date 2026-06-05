import type { PostHogService } from "@hogsend/core";

/**
 * The injected analytics service, set once by `createHogsendClient` and read by
 * the module-level task-execution sites that have no client reference of their
 * own (the journey durable task in `define-journey`, the bucket PostHog sync).
 *
 * Mirrors the journey/bucket-registry + client-schedule-defaults singletons:
 * `createHogsendClient` runs in BOTH the API and worker processes, so by the
 * time any worker task executes, the container has already installed the
 * resolved `analytics` instance here — the SAME object exposed on
 * `HogsendClient.analytics`. This makes a swapped `opts.analytics` actually
 * load-bearing at those sites instead of falling back to the module singleton.
 *
 * `undefined` is a first-class value: when `POSTHOG_API_KEY` is unset the
 * container resolves `analytics` to `undefined` and installs it here, so every
 * read remains a no-op exactly as before.
 */
let _analytics: PostHogService | undefined;

export function setAnalytics(analytics: PostHogService | undefined): void {
  _analytics = analytics;
}

export function getAnalytics(): PostHogService | undefined {
  return _analytics;
}

/** Reset the singleton — only for test cleanup. */
export function resetAnalytics(): void {
  _analytics = undefined;
}
