import type { DefinedFunnel, FunnelBinding } from "@hogsend/core";
import { DEFAULT_FUNNEL_ID } from "@hogsend/core";

/** A resolved claim: the owning funnel + the binding that matched (absent
 * when traffic merely fell through to the default funnel). */
export interface ResolvedFunnelClaim {
  funnel: DefinedFunnel;
  binding?: FunnelBinding;
}

/**
 * Funnel routing (plan §5b.4): which funnel claims a stage event's
 * (provider, pipeline). Claims come straight from each funnel's CRM
 * `bindings` — an exact pipeline claim beats a provider-wide `"*"`.
 * Overlapping claims are a boot error, not a runtime coin-flip. Events
 * nobody claims fall back to the `"default"` funnel when one is registered
 * (the `crm.{stages,stageMaps}` sugar synthesizes it).
 */
export class FunnelRegistry {
  private byId = new Map<string, DefinedFunnel>();
  /** `${provider}:${pipelineId}` (or `${provider}:*`) → funnel + binding. */
  private claims = new Map<string, ResolvedFunnelClaim>();

  constructor(funnels: DefinedFunnel[] = []) {
    for (const funnel of funnels) {
      if (this.byId.has(funnel.meta.id)) {
        throw new Error(`duplicate funnel id "${funnel.meta.id}"`);
      }
      this.byId.set(funnel.meta.id, funnel);
      for (const binding of funnel.meta.bindings ?? []) {
        const key = `${binding.provider}:${binding.pipeline}`;
        const existing = this.claims.get(key);
        if (existing) {
          throw new Error(
            `funnels "${existing.funnel.meta.id}" and "${funnel.meta.id}" both claim ` +
              `${binding.provider} pipeline "${binding.pipeline}" — one pipeline feeds one funnel`,
          );
        }
        this.claims.set(key, { funnel, binding });
      }
    }
  }

  /** Route one stage event: exact pipeline claim → provider `"*"` → default. */
  resolve(
    providerId: string,
    pipelineId: string | undefined,
  ): ResolvedFunnelClaim | undefined {
    const claimed =
      (pipelineId
        ? this.claims.get(`${providerId}:${pipelineId}`)
        : undefined) ?? this.claims.get(`${providerId}:*`);
    if (claimed) return claimed;
    const fallback = this.byId.get(DEFAULT_FUNNEL_ID);
    return fallback ? { funnel: fallback } : undefined;
  }

  get(id: string): DefinedFunnel | undefined {
    return this.byId.get(id);
  }

  getAll(): DefinedFunnel[] {
    return [...this.byId.values()];
  }

  count(): number {
    return this.byId.size;
  }
}
