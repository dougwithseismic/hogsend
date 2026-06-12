import type { AnalyticsProvider } from "@hogsend/core";

/**
 * Container-held registry of analytics providers, keyed by `provider.meta.id`
 * — the analytics sibling of `EmailProviderRegistry`. The container picks ONE
 * `active` provider out of it (env `ANALYTICS_PROVIDER` /
 * `analytics.defaultProvider`, default `"posthog"`) for the identity PULL,
 * person writes, and capture.
 *
 * Keyed with last-writer-wins, so a consumer-supplied provider of the same id
 * overrides an env preset of that id.
 */
export class AnalyticsProviderRegistry {
  private byId = new Map<string, AnalyticsProvider>();

  constructor(providers: AnalyticsProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: AnalyticsProvider): void {
    this.byId.set(provider.meta.id, provider);
  }

  get(id: string): AnalyticsProvider | undefined {
    return this.byId.get(id);
  }

  getAll(): AnalyticsProvider[] {
    return [...this.byId.values()];
  }

  count(): number {
    return this.byId.size;
  }
}
