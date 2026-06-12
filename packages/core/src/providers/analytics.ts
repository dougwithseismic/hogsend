/**
 * The provider-neutral ANALYTICS contract — the analytics sibling of
 * {@link EmailProvider}. PostHog is one implementation
 * (`@hogsend/plugin-posthog`'s `createPostHogProvider`), not the
 * architecture: the engine speaks only this contract, so the event stream /
 * person store can be Segment, Amplitude, Mixpanel, or the consumer's own
 * service without touching engine code.
 *
 * A provider owns exactly three wires plus identity:
 *
 * - **person READ** — `getPersonProperties` (the identity PULL): per-user
 *   timezone resolution at journey enrollment and property conditions. On
 *   most platforms this requires a PRIVILEGED credential (e.g. PostHog's
 *   personal API key with `person:read`) because the public capture key is
 *   write-only by design.
 * - **person WRITE** — `setPersonProperties`: trait propagation (contact →
 *   analytics person). On most platforms this rides the public capture
 *   pipeline (e.g. PostHog `$set`/`$set_once`) and needs NO extra credential.
 * - **event capture** — `capture`: fire an event under a distinct id.
 *
 * Lifecycle fan-out (email/contact/journey/bucket events) does NOT flow
 * through this contract — it rides outbound DESTINATIONS on the durable
 * delivery spine. This contract is the request/response side: reads the
 * engine needs inline, plus best-effort writes.
 */

/**
 * The minimal READ contract for the identity PULL: fetching a person's
 * properties by distinct id. This is the only role the engine REQUIRES of the
 * injected analytics provider at the hot path — per-user timezone resolution
 * at journey enrollment (`getPersonProperties` in `define-journey` /
 * `lib/timezone.ts`). Code that only needs the PULL can depend on this
 * narrower alias.
 */
export interface IdentityProvider {
  getPersonProperties(distinctId: string): Promise<Record<string, unknown>>;
}

/**
 * Person-property write payload: `set` overwrites, `setOnce` only-if-absent,
 * `unset` removes keys (e.g. the bucket mirror clears membership flags on
 * leave — `unset` rather than `set: false` so both "key = true" and "key is
 * set" cohort idioms behave correctly).
 */
export interface PersonPropertiesWrite {
  set?: Record<string, unknown>;
  setOnce?: Record<string, unknown>;
  unset?: string[];
}

/** What an {@link AnalyticsProvider} can actually do, given its credentials. */
export interface AnalyticsCapabilities {
  /**
   * True when the provider is configured for person READS (e.g. PostHog has a
   * personal API key with `person:read`). When false, `getPersonProperties`
   * soft-fails to `{}` and the engine's fallbacks (contact properties →
   * client default timezone) take over.
   */
  personReads: boolean;
  /** True when person WRITES are available (usually the capture pipeline). */
  personWrites: boolean;
  /** True when the provider supports the `hogsend connect` OAuth flow. */
  oauth?: boolean;
}

export interface AnalyticsProviderMeta {
  /** Registry key, e.g. `"posthog"`, `"segment"`. */
  id: string;
  name: string;
  description?: string;
}

/**
 * The full provider contract. All methods are best-effort wires: a provider
 * must soft-fail (resolve `{}` / no-op) rather than throw on missing
 * credentials or upstream errors — the engine treats analytics as
 * non-load-bearing.
 */
export interface AnalyticsProvider extends IdentityProvider {
  meta: AnalyticsProviderMeta;
  capabilities: AnalyticsCapabilities;

  /** Person WRITE — propagate traits onto the person profile. */
  setPersonProperties(
    opts: { distinctId: string } & PersonPropertiesWrite,
  ): Promise<void>;

  /** Event capture under a distinct id. Fire-and-forget semantics. */
  capture(opts: CaptureOptions): void;

  /** Flush/teardown any buffered capture queue. */
  shutdown?(): Promise<void>;
}

/**
 * Identity helper for authoring providers — exists for symmetry with
 * `defineEmailProvider` / `defineWebhookSource` and to give consumers a
 * single obvious entry point with full type inference.
 */
export function defineAnalyticsProvider(
  provider: AnalyticsProvider,
): AnalyticsProvider {
  return provider;
}

/**
 * @deprecated PostHog-shaped service interface, predating the neutral
 * {@link AnalyticsProvider}. Still accepted by `createHogsendClient` (an
 * adapter wraps it) — prefer passing an `AnalyticsProvider`.
 */
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
