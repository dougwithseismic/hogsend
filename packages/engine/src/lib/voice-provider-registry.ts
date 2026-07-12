import type { VoiceProvider } from "@hogsend/core";

/**
 * Container-held registry of voice providers, keyed by `provider.meta.id`. The
 * webhook route (`POST /v1/webhooks/voice/:providerId`) resolves the verifying
 * provider out of this via `c.get("container")`, and the container picks ONE
 * active provider out of it for the tracked voice caller.
 *
 * The voice sibling of {@link SmsProviderRegistry}. `meta` is REQUIRED on the
 * voice contract (no back-compat), so there is no fallback id — last-writer-wins
 * on `meta.id`.
 */
export class VoiceProviderRegistry {
  private byId = new Map<string, VoiceProvider>();

  constructor(providers: VoiceProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: VoiceProvider): void {
    this.byId.set(provider.meta.id, provider);
  }

  get(id: string): VoiceProvider | undefined {
    return this.byId.get(id);
  }

  getAll(): VoiceProvider[] {
    return [...this.byId.values()];
  }

  count(): number {
    return this.byId.size;
  }
}
