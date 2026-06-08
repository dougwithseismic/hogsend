/**
 * The minimal READ contract for the identity PULL: fetching a person's
 * properties by distinct id. This is the only role the engine still requires of
 * the injected analytics service at the hot path — per-user timezone resolution
 * at journey enrollment (`getPersonProperties` in `define-journey` /
 * `lib/timezone.ts`). It is intentionally narrow: the email/contact/journey/
 * bucket lifecycle fan-out now flows through outbound DESTINATIONS on the
 * durable spine, NOT through this provider.
 *
 * `PostHogService` satisfies `IdentityProvider` (it declares
 * `getPersonProperties` plus the deprecated capture/identify shims). Code that
 * only needs the PULL can depend on this narrower alias.
 */
export interface IdentityProvider {
  getPersonProperties(distinctId: string): Promise<Record<string, unknown>>;
}

export interface PostHogService extends IdentityProvider {
  // getPersonProperties is inherited from IdentityProvider (the identity PULL).

  captureEvent(opts: CaptureOptions): void;

  identify(distinctId: string, properties: Record<string, unknown>): void;

  isFeatureEnabled(opts: {
    distinctId: string;
    flag: string;
  }): Promise<boolean>;

  shutdown(): Promise<void>;
}

export interface CaptureOptions {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
}
