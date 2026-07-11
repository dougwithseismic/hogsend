import type { SmsProvider } from "@hogsend/core";

/**
 * Container-held registry of SMS providers, keyed by `provider.meta.id`. The
 * webhook route (`POST /v1/webhooks/sms/:providerId`) resolves the verifying
 * provider out of this via `c.get("container")`, and the container picks ONE
 * active provider out of it for the tracked SMS sender.
 *
 * The SMS sibling of {@link EmailProviderRegistry}. Unlike email, `meta` is
 * REQUIRED on the SMS contract (no pre-registry back-compat), so there is no
 * fallback id — last-writer-wins on `meta.id`.
 */
export class SmsProviderRegistry {
  private byId = new Map<string, SmsProvider>();

  constructor(providers: SmsProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: SmsProvider): void {
    this.byId.set(provider.meta.id, provider);
  }

  get(id: string): SmsProvider | undefined {
    return this.byId.get(id);
  }

  getAll(): SmsProvider[] {
    return [...this.byId.values()];
  }

  count(): number {
    return this.byId.size;
  }
}
