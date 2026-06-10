import posthog from "posthog-js";

/**
 * capture — thin wrapper over PostHog that no-ops when analytics is
 * uninitialised (no NEXT_PUBLIC_POSTHOG_KEY, or running on the server).
 * Components use this instead of importing posthog-js directly. Anonymous
 * product analytics only — never pass PII (no emails, no names).
 */
export function capture(
  event: string,
  properties?: Record<string, unknown>,
): void {
  if (typeof window === "undefined") return;
  if (!posthog.__loaded) return;
  posthog.capture(event, properties);
}
