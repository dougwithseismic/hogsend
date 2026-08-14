import type { LinkAccountResult, LinkOwner } from "./account-links.js";
import type { OutboundPayloads } from "./outbound.js";

/**
 * The ONE place an `account.*` outbound payload or dedupe key is constructed
 * (PRD 08 T3).
 *
 * Six emit sites across four PRDs build these — the hosted callback (linked +
 * four link_failed reasons), the data-plane import, two data-plane revokes,
 * the manage page, the merge's singleton-collision unlink and the
 * contact-deletion leg. Hand-rolling the shape at each of them is how the
 * `email` field ends up carrying the PROVIDER-reported address at one site and
 * the contact's at another, or how one site emits `v3` while another emits
 * `v3.0`. Everything here is a pure function of the facts a mutation already
 * returned.
 *
 * This module has NO runtime imports on purpose (both imports above are
 * `import type`, fully erased). `outbound.ts` reaches the delivery task, which
 * reaches `env.ts`, which validates at IMPORT time — a payload builder must
 * never drag that into a caller that has no env.
 *
 * ## Replay safety — there is none to reach for, and that is deliberate
 *
 * Linking happens in ROUTE-HANDLER runtime (the hosted callback, the data
 * plane), never inside a Hatchet durable task. So nothing here enters the
 * Hatchet journal, the positional-journal law that governs `ctx.sleep` /
 * `ctx.waitForEvent` / the digest+throttle primitives does not apply, and the
 * tracked mailer's exactly-once machinery (auto-keying off the replay-stable
 * Hatchet run id) is NOT involved and must not be reached for.
 *
 * Idempotency here is DB-level, in three layers: the pair advisory lock plus
 * the `(provider, provider_user_id, version)` unique constraint (DECISIONS
 * §5.6) on the write side, and the `(endpointId, dedupeKey)` partial-unique
 * index on the outbound side — which is what {@link buildDedupeKey} feeds. A
 * journey that REACTS to `account.linked` is an ordinary event-triggered
 * journey and obeys every existing replay law unchanged.
 */

/**
 * `al:<provider>:<providerUserId>:v<version>` — DECISIONS §5.5, riding the
 * existing `(endpointId, dedupeKey)` partial-unique index on
 * `webhook_deliveries`.
 *
 * A PURE TEMPLATE. Do NOT add URL-encoding, escaping or normalization: the key
 * only has to be stable and unique per mutation, and the instant its spelling
 * changes, a re-emit of a version minted before the change no longer collides
 * with the row written after it — the dedupe silently stops deduping, which no
 * delivery assertion can see.
 *
 * `version` is a decimal STRING in and a STRING out, never parsed
 * (DECISIONS §5.1: the column is a Postgres `bigint`, so `Number()` loses
 * fidelity past `Number.MAX_SAFE_INTEGER` and breaks the consumer's
 * `incoming.version > stored.version` guard in exactly the case it exists for).
 */
export function buildDedupeKey(
  provider: string,
  providerUserId: string,
  version: string,
): string {
  return `al:${provider}:${providerUserId}:v${version}`;
}

/** The two {@link LinkAccountResult} arms that actually bound something. */
type LinkedFacts = Extract<
  LinkAccountResult,
  { status: "linked" } | { status: "relinked" }
>;

/**
 * FULL CURRENT STATE for a successful bind (DECISIONS §5.2), built from the
 * facts `linkAccount()` returned and nothing else.
 *
 * `userId` and `email` come off `facts.owner` — the join to `contacts` the
 * store performed INSIDE its advisory-locked transaction (DECISIONS §15.5).
 * Neither field exists on `linked_accounts`, and re-reading them here would be
 * a read after the lock released: no longer the state that was committed.
 * `userId` is `contactKey()` (`external_id ?? anonymous_id ?? id`), the ONE
 * definition shared by the PULL, PUSH and IN-PROCESS planes — never the raw
 * `externalId`.
 *
 * `email` is the CONTACT's address. `row.verifiedEmail` (the
 * provider-reported one) is deliberately never read here: it is a display
 * property at most, and putting it in a field named `email` beside `contactId`
 * is precisely how a downstream system ends up resolving identity on it.
 */
export function buildAccountLinkedPayload(
  facts: LinkedFacts,
  at: Date = new Date(),
): OutboundPayloads["account.linked"] {
  return {
    state: "linked",
    provider: facts.row.provider,
    providerUserId: facts.row.providerUserId,
    contactId: facts.owner.contactId,
    userId: facts.owner.userId,
    email: facts.owner.email,
    username: facts.row.username,
    method: facts.row.method,
    relink: facts.relink,
    version: facts.version,
    at: at.toISOString(),
  };
}

/**
 * The facts every unlink site already has in hand.
 *
 * The merge fold's `MergedLinkUnlink` and the delete leg's `ContactUnlinkFact`
 * satisfy this structurally, so `lib/account-link-emit.ts` fans both out
 * without reshaping either. `UnlinkAccountResult` does NOT: its `unlinked` arm
 * carries `provider`/`providerUserId` on `.row`, not at the top level, so a
 * revoke site (PRD 09, PRD 11) passes those two up from `res.row` alongside
 * `res.version`, `res.owner` and its own `reason`.
 */
export interface AccountUnlinkedFacts {
  provider: string;
  providerUserId: string;
  /** That pair's OWN next version, a decimal STRING (DECISIONS §5.1). */
  version: string;
  reason: "player" | "api" | "relinked";
  /** Read inside the mutation's transaction — see {@link LinkOwner}. */
  owner: LinkOwner;
}

/**
 * FULL CURRENT STATE for a release (DECISIONS §5.2). Shares the
 * `(provider, providerUserId)` version sequence with `account.linked`, so a
 * consumer's single monotonic guard makes reorder, duplicate and late delivery
 * all no-ops.
 *
 * `contactId`/`userId`/`email` are read off `owner` and nowhere else, for the
 * same reason as {@link buildAccountLinkedPayload}.
 */
export function buildAccountUnlinkedPayload(
  facts: AccountUnlinkedFacts,
  at: Date = new Date(),
): OutboundPayloads["account.unlinked"] {
  return {
    state: "unlinked",
    provider: facts.provider,
    providerUserId: facts.providerUserId,
    contactId: facts.owner.contactId,
    userId: facts.owner.userId,
    email: facts.owner.email,
    reason: facts.reason,
    version: facts.version,
    at: at.toISOString(),
  };
}

/**
 * A link flow ended without binding anything.
 *
 * Carries NO `version` and NO `state`: nothing mutated, so there is nothing
 * for the consumer's `incoming.version > stored.version` guard to compare and
 * no current state to report. It gets NO dedupeKey either (the caller passes
 * none) — two genuine failures in a row are two genuine facts, and suppressing
 * the second would hide a brute-force pattern.
 *
 * `reason` is `AccountLinkCallbackError.reason` verbatim; PRD 01 froze that
 * union as the `account.link_failed` union minus `"vetoed"` (which only the
 * hook path produces), so there is no translation table. `contactId` is null
 * whenever the flow failed before a trustworthy contact was in hand, and this
 * event NEVER mints one (DECISIONS §8).
 */
export function buildLinkFailedPayload(
  args: {
    provider: string;
    reason: "denied" | "vetoed" | "exchange_failed" | "state_invalid";
    contactId: string | null;
  },
  at: Date = new Date(),
): OutboundPayloads["account.link_failed"] {
  return {
    provider: args.provider,
    reason: args.reason,
    contactId: args.contactId,
    at: at.toISOString(),
  };
}
