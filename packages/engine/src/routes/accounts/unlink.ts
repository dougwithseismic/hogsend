import type { Context } from "hono";
import type { AppEnv } from "../../app.js";
import {
  type UnlinkAccountResult,
  unlinkAccount,
} from "../../lib/account-links.js";
import { noteUnlinked } from "./emit.js";

/**
 * ONE unlink, the way every `/v1/accounts/*` route must do it (PRD 09 T4/T8b).
 *
 * Three things are bundled here precisely because a second copy would drift on
 * one of them:
 *
 *  1. The store call carries `hooks: container.accountLinkHooks`. The STORE is
 *     the sole invoker of the post-commit after-unlink hook (DECISIONS §15.4)
 *     — a route that also invoked it would fire every customer hook twice, and
 *     the hooks being documented at-least-once means nothing would fail
 *     loudly. The hook's NAME is deliberately not spelled out anywhere under
 *     `routes/accounts/`, so a grep for the identifier stays a reviewable
 *     invariant rather than a convention.
 *  2. The provider's best-effort `revoke` wire is handed in, so a token grant
 *     is released at the platform when a link ends (DECISIONS §10). The store
 *     unseals the blob post-commit and never returns or logs it.
 *  3. Exactly ONE `account.unlinked` is emitted, from the INTENT layer, off the
 *     facts the store returned inside its advisory-locked transaction, keyed
 *     `al:<provider>:<uid>:v<version>` (DECISIONS §5.5/§8). A `not_found` or a
 *     `not_owner` rejection emits NOTHING: nothing transitioned.
 *
 * `expectContactId` is the caller's business. It is REQUIRED on every
 * player-facing revoke and evaluated INSIDE the pair lock, after the live-owner
 * probe — the enumeration that found the rows happened outside the lock, and a
 * hosted callback can relink the pair in between.
 */
export async function unlinkFromRoute(
  c: Context<AppEnv>,
  opts: {
    provider: string;
    providerUserId: string;
    reason: "player" | "api";
    expectContactId?: string;
  },
): Promise<UnlinkAccountResult> {
  const {
    accountLinkHooks,
    accountLinkProviders,
    analytics,
    db,
    hatchet,
    logger,
    registry,
  } = c.get("container");

  const provider = accountLinkProviders.get(opts.provider);
  const revoke = provider?.revoke?.bind(provider);

  const result = await unlinkAccount({
    db,
    provider: opts.provider,
    providerUserId: opts.providerUserId,
    reason: opts.reason,
    ...(opts.expectContactId ? { expectContactId: opts.expectContactId } : {}),
    ...(revoke ? { revoke: (tokens) => revoke(tokens) } : {}),
    hooks: accountLinkHooks,
    logger,
  });

  if (result.status !== "unlinked") return result;

  logger.info("account unlinked", {
    provider: opts.provider,
    reason: opts.reason,
    version: result.version,
    contactId: result.owner.contactId,
  });

  // `void … .catch` per `emitOutbound`'s contract: it never throws, and an
  // emit must never fail a mutation the customer already committed.
  void noteUnlinked(
    {
      providerId: opts.provider,
      db,
      hatchet,
      logger,
      registry,
      ...(analytics ? { analytics } : {}),
    },
    {
      provider: opts.provider,
      providerUserId: opts.providerUserId,
      version: result.version,
      reason: opts.reason,
      owner: result.owner,
    },
  ).catch(logger.warn);

  return result;
}
