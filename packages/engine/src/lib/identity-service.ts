import type { AnalyticsProvider } from "@hogsend/core";
import type { Database } from "@hogsend/db";
import {
  logResidualTwins,
  mergeAnalyticsIdentities,
} from "./analytics-identity.js";
import { resolveOrCreateContact } from "./contacts.js";
import type { Logger } from "./logger.js";

/**
 * Args for {@link IdentityService.linkContact} — the same identity-attach inputs
 * `resolveOrCreateContact` accepts (at least one of `userId`/`email`/
 * `anonymousId`/`discordId` is required by the resolver), minus the `db` (the
 * service closes over the container's db).
 */
export interface LinkContactArgs {
  userId?: string;
  email?: string;
  anonymousId?: string;
  discordId?: string;
  contactProperties?: Record<string, unknown>;
}

/**
 * The container-held identity helper (`client.identity`). It exists so any
 * identity-attach OUTSIDE the `/v1/events` ingest path — most notably Discord
 * `/link` (§7), but also any consumer wiring — folds two keys into one analytics
 * person through the SAME engine emission used by `ingestEvent` (§5.3), rather
 * than each consumer hand-rolling its own `resolveOrCreateContact` +
 * `mergeIdentities` plumbing (the bespoke path the spec calls out as the bug).
 */
export interface IdentityService {
  /**
   * Resolve / merge a contact AND propagate the analytics merge in one call.
   *
   * Wraps `resolveOrCreateContact` (the resolver stays analytics-free — it takes
   * only `db`) then, on a collide-MERGE or canonical-key flip that absorbed an
   * anonymous/uuid key, fans out the provider-neutral `mergeIdentities` primitive
   * via {@link mergeAnalyticsIdentities} with `reason: "discord_link"`. MF-2:
   * `mergedKeys` already excludes identified `external_id`s (the resolver split
   * them out) — only the safe anon/uuid keys are aliased; the excluded
   * identified twins surface as `identity.merge.residual_twin` for observability.
   *
   * The SURVIVOR RULE makes `resolvedKey` the survivor (`distinctId`) and each
   * loser its absorbed `alias` — e.g. on a Discord `/link` that merges the
   * discord-keyed contact into the email contact, `distinctId = resolvedKey`
   * (survivor, email/external) and `alias = <discord-contact uuid>` (the
   * loser's anon/uuid key the Discord-platform events were captured under).
   *
   * Best-effort and analytics-non-load-bearing: the merge emission never throws
   * (the helper swallows provider errors), so a missing/incapable provider
   * no-ops cleanly — the contact resolve still happened and is returned.
   */
  linkContact(args: LinkContactArgs): ReturnType<typeof resolveOrCreateContact>;
}

/**
 * Build the {@link IdentityService} bound to a container's db + active analytics
 * provider. `analytics` is undefined when nothing is configured (the merge
 * emission no-ops); the resolver itself is unaffected.
 */
export function createIdentityService(deps: {
  db: Database;
  analytics?: AnalyticsProvider;
  logger?: Logger;
}): IdentityService {
  const { db, analytics, logger } = deps;

  return {
    async linkContact(args) {
      const result = await resolveOrCreateContact({ db, ...args });

      const {
        id: contactId,
        resolvedKey,
        mergedKeys,
        mergedIdentifiedKeys,
      } = result;

      // §5.3 emission point 1, reused (§7): fire the analytics merge ONLY when
      // the resolver actually folded keys this call. MF-2: `mergedKeys` carries
      // the safe anon/uuid losers (the discord-contact uuid on a `/link` merge);
      // identified `external_id`s are excluded by the resolver and surfaced as
      // residual twins below — never aliased (the merge PostHog refuses, R2/R4).
      if (mergedKeys?.length) {
        mergeAnalyticsIdentities({
          analytics,
          survivorKey: resolvedKey,
          loserKeys: mergedKeys,
          reason: "discord_link",
          contactId,
          logger,
        });
      }
      if (mergedIdentifiedKeys?.length) {
        logResidualTwins({
          survivorKey: resolvedKey,
          identifiedLoserKeys: mergedIdentifiedKeys,
          contactId,
          logger,
        });
      }

      return result;
    },
  };
}
