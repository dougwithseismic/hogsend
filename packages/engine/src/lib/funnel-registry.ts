import type {
  DefinedFunnel,
  FunnelBinding,
  FunnelTransition,
} from "@hogsend/core";
import { DEFAULT_FUNNEL_ID } from "@hogsend/core";

/** A resolved claim: the owning funnel + the binding that matched (absent
 * when traffic merely fell through to the default funnel). */
export interface ResolvedFunnelClaim {
  funnel: DefinedFunnel;
  binding?: FunnelBinding;
}

/** One event→stage rule bound to its owning funnel. */
export interface FunnelTransitionMatch {
  funnel: DefinedFunnel;
  transition: FunnelTransition;
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
  /** Event name → the transitions (across funnels) it can fire. */
  private transitions = new Map<string, FunnelTransitionMatch[]>();
  /** Trigger events wired to a quoted/won milestone stage. */
  private milestoneTriggers = new Set<string>();

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
      for (const transition of funnel.transitions) {
        const list = this.transitions.get(transition.event) ?? [];
        list.push({ funnel, transition });
        this.transitions.set(transition.event, list);
        if (
          transition.stageId === funnel.ladder.quotedStage ||
          transition.stageId === funnel.ladder.soldStage
        ) {
          this.milestoneTriggers.add(transition.event);
        }
      }
    }
  }

  /** Event→stage rules listening on this event name (empty when none). */
  transitionsFor(event: string): FunnelTransitionMatch[] {
    return this.transitions.get(event) ?? [];
  }

  /**
   * Trigger events wired to a money-milestone stage in ANY funnel. Their
   * value is handed to the minted `deal.quoted`/`deal.sold`, so revenue
   * rollups exclude the raw trigger rows (else one sale counts twice).
   */
  milestoneTriggerEvents(): string[] {
    return [...this.milestoneTriggers];
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
