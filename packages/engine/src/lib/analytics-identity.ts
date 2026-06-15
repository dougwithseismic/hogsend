import type { AnalyticsProvider } from "@hogsend/core";
import type { Logger } from "./logger.js";

/**
 * The reason a merge was emitted — surfaced on the `identity.merge.emitted`
 * structured log so an operator can see WHICH resolver path stitched (§10.5). A
 * declining `collide_merge` / `key_flip` volume after anon threading lands
 * (Stage 1) is the empirical "forks prevented" signal.
 */
export type IdentityMergeReason =
  | "collide_merge"
  | "key_flip"
  | "click_identify"
  | "discord_link";

/**
 * Fan out the provider-neutral `mergeIdentities` primitive (§5.3) once per
 * loser key, folding each absorbed (anonymous/uuid) key INTO the surviving
 * canonical contact key. Fire-and-forget and never throws: analytics is
 * non-load-bearing, so a provider error must not fail the ingest that triggered
 * the merge.
 *
 * Direction is load-bearing (MF-1): `survivorKey` is the SURVIVING/canonical
 * (identified) id and each `loserKey` is the ABSORBED (anonymous) one — mapped
 * straight to `mergeIdentities({ distinctId: survivorKey, alias: loserKey })`.
 *
 * No-ops cleanly when:
 * - no provider is injected (`!analytics`),
 * - the active provider can't merge (`!capabilities.identityMerge` — a legacy
 *   adapter or a provider without an `alias` wire),
 * - or it carries no `mergeIdentities` method.
 *
 * MF-2: callers MUST pass only the SAFE-to-absorb loser keys (anonymous/uuid,
 * never an `external_id` that already identified a PostHog person). Aliasing an
 * already-identified key is the identified→identified merge PostHog refuses
 * (R2/R4) — it silently no-ops AND spams "Refused to merge" warnings on the
 * normal merge path. The filtering happens at the emission point (the resolver
 * splits its loser keys into safe vs. identified); this helper only fans out
 * what it is given and skips a self-alias (`loserKey === survivorKey`).
 */
export function mergeAnalyticsIdentities(opts: {
  analytics?: AnalyticsProvider;
  survivorKey: string;
  loserKeys: string[];
  /** Stitching path, for the `identity.merge.emitted` observability log. */
  reason: IdentityMergeReason;
  /** The contact id, for correlating the merge log to a contact row. */
  contactId?: string;
  logger?: Logger;
}): void {
  const { analytics, survivorKey, loserKeys, reason, contactId, logger } = opts;

  if (!analytics?.capabilities.identityMerge) {
    if (loserKeys.length > 0) {
      logger?.debug("identity.merge.skipped", {
        reason: analytics ? "no_capability" : "no_provider",
      });
    }
    return;
  }
  if (!analytics.mergeIdentities) return;

  for (const loserKey of loserKeys) {
    if (!loserKey || loserKey === survivorKey) {
      logger?.debug("identity.merge.skipped", { reason: "self_alias" });
      continue;
    }
    try {
      analytics.mergeIdentities({ distinctId: survivorKey, alias: loserKey });
      logger?.info("identity.merge.emitted", {
        provider: analytics.meta.id,
        survivorKey,
        alias: loserKey,
        reason,
        ...(contactId ? { contactId } : {}),
      });
    } catch (err) {
      // Best-effort: analytics is non-load-bearing — never throw.
      logger?.warn("identity.merge.failed", {
        provider: analytics.meta.id,
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Emit the `identity.merge.residual_twin` observability log (§10.5) for each
 * loser key MF-2 excluded from the safe fan-out: a loser carrying an
 * `external_id` is, by the engine's own model, an already-identified PostHog
 * person, and PostHog refuses to merge two identified persons on the safe path.
 * These twins are the known steady-state residual (OQ-1) made visible — NOT an
 * error, just the honest "one email → one person, except across two prior
 * identified persons" outcome surfaced for monitoring.
 */
export function logResidualTwins(opts: {
  survivorKey: string;
  identifiedLoserKeys: string[];
  contactId?: string;
  logger?: Logger;
}): void {
  const { survivorKey, identifiedLoserKeys, contactId, logger } = opts;
  for (const loserExternalId of identifiedLoserKeys) {
    if (!loserExternalId || loserExternalId === survivorKey) continue;
    logger?.info("identity.merge.residual_twin", {
      survivorKey,
      loserExternalId,
      ...(contactId ? { contactId } : {}),
    });
  }
}
