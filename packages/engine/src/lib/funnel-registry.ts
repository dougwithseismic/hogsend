import type { DefinedFunnel } from "@hogsend/core";
import { DEFAULT_FUNNEL_ID } from "@hogsend/core";

/**
 * Funnel routing (plan §5b.4): which funnel claims a stage event's
 * (provider, pipeline). Claims come straight from each funnel's
 * `sources[provider]` pipeline keys — an exact pipeline key beats a
 * provider-wide `"*"`. Overlapping claims are a boot error, not a runtime
 * coin-flip. Events nobody claims fall back to the `"default"` funnel when
 * one is registered (the `crm.{stages,stageMaps}` sugar synthesizes it).
 */
export class FunnelRegistry {
  private byId = new Map<string, DefinedFunnel>();
  /** `${provider}:${pipelineId}` (or `${provider}:*`) → funnel. */
  private claims = new Map<string, DefinedFunnel>();

  constructor(funnels: DefinedFunnel[] = []) {
    for (const funnel of funnels) {
      if (this.byId.has(funnel.meta.id)) {
        throw new Error(`duplicate funnel id "${funnel.meta.id}"`);
      }
      this.byId.set(funnel.meta.id, funnel);
      for (const [providerId, map] of Object.entries(funnel.meta.sources)) {
        for (const pipelineId of Object.keys(map)) {
          const key = `${providerId}:${pipelineId}`;
          const existing = this.claims.get(key);
          if (existing) {
            throw new Error(
              `funnels "${existing.meta.id}" and "${funnel.meta.id}" both claim ` +
                `${providerId} pipeline "${pipelineId}" — one pipeline feeds one funnel`,
            );
          }
          this.claims.set(key, funnel);
        }
      }
    }
  }

  /** Route one stage event: exact pipeline claim → provider `"*"` → default. */
  resolve(
    providerId: string,
    pipelineId: string | undefined,
  ): DefinedFunnel | undefined {
    return (
      (pipelineId
        ? this.claims.get(`${providerId}:${pipelineId}`)
        : undefined) ??
      this.claims.get(`${providerId}:*`) ??
      this.byId.get(DEFAULT_FUNNEL_ID)
    );
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
