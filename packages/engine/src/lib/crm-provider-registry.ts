import type { CrmProvider } from "@hogsend/core";
import { EVENTS_DEAL_PROVIDER } from "./crm-deals.js";

/**
 * Container-held registry of CRM providers, keyed by `provider.meta.id`. The
 * webhook route (`POST /v1/webhooks/crm/:providerId`) resolves the verifying
 * provider out of this; the reconciliation poll task walks `getAll()`.
 *
 * The CRM sibling of {@link SmsProviderRegistry}. Unlike email/SMS there is
 * no single "active" provider — MANY CRMs sync concurrently (an agency
 * deployment syncs a different CRM per client); `pushLead` callers name the
 * provider explicitly.
 */
export class CrmProviderRegistry {
  private byId = new Map<string, CrmProvider>();

  constructor(providers: CrmProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: CrmProvider): void {
    if (provider.meta.id === EVENTS_DEAL_PROVIDER) {
      throw new Error(
        `CRM provider id "${EVENTS_DEAL_PROVIDER}" is reserved for deals minted by funnel event triggers`,
      );
    }
    this.byId.set(provider.meta.id, provider);
  }

  get(id: string): CrmProvider | undefined {
    return this.byId.get(id);
  }

  getAll(): CrmProvider[] {
    return [...this.byId.values()];
  }

  count(): number {
    return this.byId.size;
  }
}
