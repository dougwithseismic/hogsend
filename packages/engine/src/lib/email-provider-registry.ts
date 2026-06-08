import type { EmailProvider } from "@hogsend/core";

/**
 * Container-held registry of email providers, keyed by `provider.meta.id`. The
 * webhook route (`POST /v1/webhooks/email/:providerId`) resolves the verifying
 * provider out of this registry via `c.get("container")`, and the container
 * also picks ONE `active` provider out of it for the mailer.
 *
 * Deliberately NOT a process singleton: unlike the `DestinationRegistry`
 * singleton — which exists only because the self-booting `deliverWebhookTask`
 * has no container — both readers of this registry (the mailer the container
 * constructs, and the webhook route which has the container) have a container
 * reference, so the singleton + lazy-preset fallback would be dead weight.
 *
 * Keyed by `meta.id` with last-writer-wins, so a consumer-supplied provider of
 * the same id overrides an env preset of that id.
 */
export class EmailProviderRegistry {
  private byId = new Map<string, EmailProvider>();

  constructor(providers: EmailProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  /**
   * Register (or replace) a provider. Falls back to `"resend"` for a provider
   * built before `meta` existed (the contract keeps `meta` optional for
   * back-compat). Last-writer-wins.
   */
  register(provider: EmailProvider): void {
    this.byId.set(provider.meta?.id ?? "resend", provider);
  }

  get(id: string): EmailProvider | undefined {
    return this.byId.get(id);
  }

  getAll(): EmailProvider[] {
    return [...this.byId.values()];
  }

  count(): number {
    return this.byId.size;
  }
}
