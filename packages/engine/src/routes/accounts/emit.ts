import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { Database } from "@hogsend/db";
import {
  type AccountUnlinkedFacts,
  buildAccountLinkedPayload,
  buildAccountUnlinkedPayload,
  buildDedupeKey,
} from "../../lib/account-link-events.js";
import type { LinkAccountResult } from "../../lib/account-links.js";
import type { Logger } from "../../lib/logger.js";
import { emitOutbound } from "../../lib/outbound.js";

/**
 * THE `/v1/accounts/*` EMIT SITES, in one module.
 *
 * DECISIONS §8/§15.7: the STORE returns facts and never emits; the INTENT
 * layer (these routes) emits. Two intent layers now produce link endings — the
 * hosted callback and the data plane's two revokes plus the import — and the
 * shape has to be identical at all of them, so it lives here rather than being
 * re-derived per route. A drifted key or a payload built from the wrong pair is
 * invisible in production: `emitOutbound` de-dupes on
 * `(endpointId, dedupeKey)` with `onConflictDoNothing`, so a wrong key silently
 * stops de-duping and a colliding one silently swallows a real fact.
 */

/**
 * Everything an emit needs from the request.
 *
 * `hatchet` is carried ONLY to satisfy `emitOutbound`'s signature, and saying
 * anything stronger would be false: `emitOutbound` destructures
 * `const { db, logger, event, payload, dedupeKey } = opts` and never reads
 * `opts.hatchet`; the enqueue runs through the MODULE-LEVEL
 * `deliverWebhookTask` built from the `lib/hatchet.ts` singleton at import
 * time.
 */
export interface AccountLinkEmitContext {
  providerId: string;
  db: Database;
  hatchet: HatchetClient;
  logger: Logger;
}

/**
 * THE `account.linked` SITE, emitting off the facts the store returned.
 *
 * One mutation can END up to two links, and every ending is emitted BEFORE the
 * `account.linked` that caused it. The ORDER IS LOAD-BEARING for the `previous`
 * leg: `account.unlinked` for the displaced owner at the LOWER version (N+1)
 * FIRST, then `account.linked` at the higher one (N+2). A consumer's guard is
 * `incoming.version > stored.version`, so if the two deliveries arrive out of
 * order the late unlink at N+1 is DISCARDED against a stored N+2 — rather than
 * winning and permanently recording the wrong owner.
 *
 * The emits are therefore CHAINED, not fired side by side: independent
 * `void emitOutbound(...)` calls race their own INSERTs, which is no ordering
 * at all. Chaining keeps the handler non-blocking (nothing is awaited here)
 * while making each unlink's delivery row — and its enqueue — strictly first.
 *
 * The two endings, which are NOT the same thing:
 *
 *  - `previous` — the SAME platform account changing hands (a hosted callback
 *    only; every other caller passes `allowDisplaceLiveOwner: false`). Its
 *    unlink shares this pair's version sequence, which is why order matters.
 *  - `replacedSingleton` — this contact's OTHER pair on a `multiple: false`
 *    provider, soft-unlinked to make room. It is a DIFFERENT pair with its OWN
 *    version sequence, so its dedupe key is built from `r.provider` /
 *    `r.providerUserId`, never from `result.row`'s. A key built from the NEW
 *    pair would collide with the `account.linked` emit and be silently
 *    swallowed by `onConflictDoNothing`. **It is returned on the `linked` arm
 *    too, not only `relinked`** — which is exactly why this fan-out is shared
 *    rather than re-written per call site.
 */
export function noteLinked(
  ctx: AccountLinkEmitContext,
  result: Extract<LinkAccountResult, { status: "linked" | "relinked" }>,
): void {
  ctx.logger.info("account linked", {
    provider: ctx.providerId,
    status: result.status,
    version: result.version,
    contactId: result.owner.contactId,
  });

  const { provider, providerUserId } = result.row;
  const linked = () =>
    emitOutbound({
      db: ctx.db,
      hatchet: ctx.hatchet,
      logger: ctx.logger,
      event: "account.linked",
      payload: buildAccountLinkedPayload(result),
      dedupeKey: buildDedupeKey(provider, providerUserId, result.version),
    });

  // Every ending this mutation produced, each with ITS OWN pair, version and
  // owner — all read by the store inside the pair-locked transaction and never
  // re-read here.
  const ended: AccountUnlinkedFacts[] = [];
  if (result.replacedSingleton) {
    const r = result.replacedSingleton;
    ended.push({
      provider: r.provider,
      providerUserId: r.providerUserId,
      version: r.version,
      reason: "relinked",
      owner: r.owner,
    });
  }
  if (result.status === "relinked") {
    ended.push({
      provider,
      providerUserId,
      version: result.previous.version,
      reason: "relinked",
      owner: result.previous.owner,
    });
  }

  if (ended.length === 0) {
    void linked().catch(ctx.logger.warn);
    return;
  }

  void ended
    .reduce<Promise<void>>(
      (chain, facts) => chain.then(() => noteUnlinked(ctx, facts)),
      Promise.resolve(),
    )
    .then(linked)
    .catch(ctx.logger.warn);
}

/**
 * One `account.unlinked`, keyed off the facts' OWN pair.
 *
 * The key is derived HERE rather than at the call site so the pair in the
 * payload and the pair in the dedupe key cannot be different pairs — the exact
 * mistake that would make a `replacedSingleton` emit collide with the
 * `account.linked` it accompanies.
 *
 * Returns the promise (rather than firing and forgetting) so `noteLinked` can
 * CHAIN the ordering; the fire-and-forget `void … .catch` belongs to the
 * caller, exactly as `emitOutbound`'s own contract asks.
 */
export function noteUnlinked(
  ctx: AccountLinkEmitContext,
  facts: AccountUnlinkedFacts,
): Promise<void> {
  return emitOutbound({
    db: ctx.db,
    hatchet: ctx.hatchet,
    logger: ctx.logger,
    event: "account.unlinked",
    payload: buildAccountUnlinkedPayload(facts),
    dedupeKey: buildDedupeKey(
      facts.provider,
      facts.providerUserId,
      facts.version,
    ),
  });
}
