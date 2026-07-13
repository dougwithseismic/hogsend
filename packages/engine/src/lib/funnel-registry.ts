import type { DefinedFunnel, FunnelEventStage } from "@hogsend/core";
import { DEFAULT_FUNNEL_ID } from "@hogsend/core";

/** One event-stage matcher plus the funnel that owns it. */
export interface FunnelEventClaim extends FunnelEventStage {
  funnel: DefinedFunnel;
}

/**
 * Funnel routing (plan §5b.4): which funnel claims a stage event's
 * (provider, pipeline). Claims come straight from each funnel's
 * `sources[provider]` pipeline keys — an exact pipeline key beats a
 * provider-wide `"*"`. Overlapping claims are a boot error, not a runtime
 * coin-flip. Events nobody claims fall back to the `"default"` funnel when
 * one is registered (the `crm.{stages,stageMaps}` sugar synthesizes it).
 *
 * Event-stage matchers (impact plan §3.3) are indexed by event name for the
 * ingest-time `funnel_progress` projection. Deliberately NON-exclusive:
 * several funnels may watch the same event (parallel lenses), unlike
 * pipeline claims.
 */
export class FunnelRegistry {
  private byId = new Map<string, DefinedFunnel>();
  /** `${provider}:${pipelineId}` (or `${provider}:*`) → funnel. */
  private claims = new Map<string, DefinedFunnel>();
  /** event name → every funnel stage matcher watching it. */
  private eventClaims = new Map<string, FunnelEventClaim[]>();

  constructor(funnels: DefinedFunnel[] = []) {
    for (const funnel of funnels) {
      if (this.byId.has(funnel.meta.id)) {
        throw new Error(`duplicate funnel id "${funnel.meta.id}"`);
      }
      this.byId.set(funnel.meta.id, funnel);
      for (const [providerId, map] of Object.entries(
        funnel.meta.sources ?? {},
      )) {
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
      for (const eventStage of funnel.eventStages ?? []) {
        const list = this.eventClaims.get(eventStage.event) ?? [];
        list.push({ ...eventStage, funnel });
        this.eventClaims.set(eventStage.event, list);
      }
    }
  }

  /** Every funnel stage matcher watching `event` (§3.3). */
  forEvent(event: string): FunnelEventClaim[] {
    return this.eventClaims.get(event) ?? [];
  }

  /** Whether ANY funnel declares event stages (cheap ingest pre-check). */
  hasEventStages(): boolean {
    return this.eventClaims.size > 0;
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
