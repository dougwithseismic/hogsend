import type { AccountLinkProvider } from "@hogsend/core";

/**
 * Container-held registry of account-link providers, keyed by
 * `provider.meta.id` — a direct structural mirror of the
 * {@link EmailProviderRegistry} (`lib/email-provider-registry.ts`). The hosted
 * flow routes (`/v1/accounts/:provider/start` + `/callback`, PRD 07), the data
 * plane (PRD 09) and the property-sync cron (PRD 14) all resolve providers out
 * of this via the container.
 *
 * Deliberately NOT a process singleton, for the same reason spelled out on the
 * email registry: every reader holds a container reference, so a singleton +
 * lazy-preset fallback would be dead weight.
 *
 * Divergence from the email registry: `meta.id` is REQUIRED here. The email
 * registry falls back to `"resend"` for providers built before `meta` existed;
 * this contract is new and has no pre-`meta` era, so an empty/absent id is a
 * `TypeError` rather than a silent default. It does NOT re-validate
 * `ACCOUNT_LINK_ID_RE` / `RESERVED_ACCOUNT_LINK_IDS` — `defineAccountLink()`
 * already throws on both at definition time, and a second copy of that rule is
 * a second place to update.
 *
 * Last-writer-wins on `meta.id`, so a consumer-supplied provider of the same id
 * overrides an env preset of that id (env presets are constructed first).
 */
export class AccountLinkProviderRegistry {
  private byId = new Map<string, AccountLinkProvider>();

  constructor(providers: AccountLinkProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  /** Register (or replace) a provider. Last-writer-wins on `meta.id`. */
  register(provider: AccountLinkProvider): void {
    const id = provider.meta?.id;
    if (!id) {
      throw new TypeError(
        "account link provider has no meta.id — the id keys the registry " +
          "and is the `:provider` route segment, so it is required " +
          "(author providers with defineAccountLink, which enforces it)",
      );
    }
    this.byId.set(id, provider);
  }

  get(id: string): AccountLinkProvider | undefined {
    return this.byId.get(id);
  }

  getAll(): AccountLinkProvider[] {
    return [...this.byId.values()];
  }

  ids(): string[] {
    return [...this.byId.keys()];
  }

  count(): number {
    return this.byId.size;
  }
}
