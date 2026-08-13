import {
  AccountLinkCallbackError,
  type BeforeLinkContext,
  type LinkedIdentity,
} from "@hogsend/core";
import { contacts, type Database } from "@hogsend/db";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { runBeforeLink } from "../../lib/account-link-hooks.js";
import { burnAccountLinkNonce } from "../../lib/account-link-nonce.js";
import { isAllowedReturnTo } from "../../lib/account-link-origins.js";
import { takePkceVerifier } from "../../lib/account-link-pkce.js";
import { checkAccountLinkThrottle } from "../../lib/account-link-throttle.js";
import { getLiveLink, linkAccount } from "../../lib/account-links.js";
import { verifyConnectorState } from "../../lib/connector-state.js";
import {
  collidesWithIdentified,
  PublishableAnonymousMergeError,
  resolveOrCreateContact,
} from "../../lib/contacts.js";
import type { Logger } from "../../lib/logger.js";
import { getRedisIfConnected } from "../../lib/redis.js";
import { accountLinkErrorPage, accountLinkSuccessPage } from "./pages.js";
import {
  accountLinkCallbackRedirectUri,
  accountLinkClientIp,
} from "./shared.js";

/**
 * `GET /v1/accounts/:provider/callback` — the ONE place in the whole feature
 * where a link may MOVE (DECISIONS §6.1). Everything else — the import path,
 * the SDK, the manage page — is structurally unable to displace a live owner,
 * because only this route ever passes `allowDisplaceLiveOwner: true`, and only
 * on the WARM path.
 *
 * The order below mirrors `routes/connectors/index.ts:100-159` step for step,
 * because that dispatcher's hardening is the thing being reused rather than
 * re-derived: verify BEFORE dispatching, reject a cross-surface state, burn the
 * nonce single-use. The two deliberate divergences are commented at their
 * sites: a null Redis REFUSES here (fail closed), and the contact side of the
 * link is decided here rather than by the store.
 */

/** Everything the failure/success notes need to answer identically. */
interface FailureContext {
  providerId: string;
  logger: Logger;
}

export function registerAccountLinkCallbackRoute(router: OpenAPIHono<AppEnv>) {
  router.openapi(
    createRoute({
      method: "get",
      path: "/{provider}/callback",
      tags: ["Account links"],
      summary: "Complete a hosted account link",
      request: { params: z.object({ provider: z.string() }) },
      responses: {
        200: { description: "Linked — the hosted success page" },
        302: { description: "Linked — redirect to the allowlisted returnTo" },
        400: { description: "Refused — the hosted error page" },
        404: { description: "Unknown provider" },
        429: { description: "Throttled" },
        503: { description: "Redis unavailable (fail closed)" },
      },
    }),
    async (c) => {
      const { provider: providerId } = c.req.valid("param");
      const container = c.get("container");
      const {
        accountLinkProviders,
        accountLinkAllowedOrigins,
        accountLinkHooks,
        db,
        env,
        logger,
      } = container;

      // (1) Provider.
      const provider = accountLinkProviders.get(providerId);
      if (!provider) return c.json({ error: "unknown_provider" }, 404);
      const fail: FailureContext = { providerId, logger };
      const errorPage = () =>
        c.html(accountLinkErrorPage(provider.meta.name), 400);

      // (2) Redis, FAIL-CLOSED. See `lib/account-link-nonce.ts` for why this
      // diverges from the connector callback's degrade-to-TTL posture.
      if (!getRedisIfConnected()) {
        logger.error(
          "account link callback refused: redis is not connected — the " +
            "single-use nonce burn cannot run, and a TTL-replayable " +
            "account-link state can MOVE a link. Set REDIS_URL",
          { provider: providerId },
        );
        return c.json({ error: "unavailable" }, 503);
      }

      // (3) Throttle. This endpoint is public and does real work (a code
      // exchange, a DB write), so it is budgeted before any of it happens.
      const ip = accountLinkClientIp(c);
      const budget = await checkAccountLinkThrottle({
        surface: "callback",
        ip,
      });
      if (!budget.ok) {
        return budget.reason === "rate_limited"
          ? c.json({ error: "rate_limited" }, 429)
          : c.json({ error: "unavailable" }, 503);
      }

      const url = new URL(c.req.url);
      const query = Object.fromEntries(url.searchParams.entries());

      // (4) VERIFY BEFORE DISPATCHING. A missing/forged/expired state never
      // reaches the provider: no code is exchanged, no `beforeLink` runs, no
      // contact is touched. This is the same rule (and the same comment) as the
      // connector callback, and it is what makes "never calls handleCallback on
      // a bad state" an assertion rather than a hope.
      const stateToken = query.state ?? "";
      const check = verifyConnectorState(stateToken, env.BETTER_AUTH_SECRET);
      if (!check.valid || !check.intent) {
        logger.warn("account link callback: invalid state", {
          provider: providerId,
          reason: check.reason,
        });
        // `contactId: null` — a state that did not verify carries nothing
        // trustworthy, and a failure NEVER mints a contact (DECISIONS §8).
        noteLinkFailed(fail, "state_invalid", null);
        return errorPage();
      }
      const intent = check.intent;

      // (5) Purpose. One secret signs every state in the process, so a
      // `member_link` state is signature-valid here too.
      if (intent.purpose !== "account_link") {
        logger.warn("account link callback: wrong state purpose", {
          provider: providerId,
          purpose: intent.purpose,
        });
        noteLinkFailed(fail, "state_invalid", null);
        return errorPage();
      }

      // (6) Cross-provider replay: a state minted for steam, presented at
      // /twitch/callback, is signature-valid and must still be refused.
      if (intent.providerId !== providerId) {
        logger.warn("account link callback: state provider mismatch", {
          routeProviderId: providerId,
          stateProviderId: intent.providerId,
        });
        noteLinkFailed(fail, "state_invalid", null);
        return errorPage();
      }

      // (7) SINGLE-USE. The signed state is otherwise replayable until `exp`,
      // and a replayed account-link callback can MOVE a platform account
      // between contacts. A null/faulting Redis is a REJECT here, not a bypass.
      if (!(await burnAccountLinkNonce(intent.nonce))) {
        logger.warn("account link callback: state replay rejected", {
          provider: providerId,
        });
        noteLinkFailed(fail, "state_invalid", intent.contactId ?? null);
        return errorPage();
      }

      // (8) PKCE custody, consumed with GETDEL. A declared-PKCE provider whose
      // verifier is missing cannot prove what the flow claims it proves.
      let codeVerifier: string | undefined;
      if (provider.capabilities?.pkce) {
        const verifier = await takePkceVerifier(intent.nonce);
        if (!verifier) {
          logger.warn(
            "account link callback: no PKCE verifier for this state",
            {
              provider: providerId,
            },
          );
          noteLinkFailed(fail, "state_invalid", intent.contactId ?? null);
          return errorPage();
        }
        codeVerifier = verifier;
      }

      // (9) The proof. The provider maps a denial to
      // `AccountLinkCallbackError{denied}` itself (PRD 01 T3/T4), so this route
      // does NOT sniff for `error=access_denied` or `openid.mode=cancel` — it
      // reads `err.reason` verbatim, which is why that union is deliberately
      // the `link_failed` reasons minus `"vetoed"`.
      //
      // No `fetchImpl` is passed: the presets resolve `fetchImpl ??
      // globalThis.fetch`, and tests inject at the provider instead of through
      // a container-level fetch seam that production would never use.
      let identity: LinkedIdentity;
      try {
        identity = await provider.handleCallback({
          query,
          redirectUri: accountLinkCallbackRedirectUri({
            apiPublicUrl: env.API_PUBLIC_URL,
            providerId,
            state: stateToken,
            query,
          }),
          ...(codeVerifier ? { codeVerifier } : {}),
        });
      } catch (err) {
        const reason =
          err instanceof AccountLinkCallbackError
            ? err.reason
            : "exchange_failed";
        // The MESSAGE only. An OAuth error body can carry a token, so a
        // provider must never interpolate one into its message and this must
        // never log a body.
        logger.warn("account link callback: provider refused", {
          provider: providerId,
          reason,
          error: err instanceof Error ? err.message : "unknown error",
        });
        noteLinkFailed(fail, reason, intent.contactId ?? null);
        return errorPage();
      }

      // Who owns this platform account RIGHT NOW — read once, for the hook's
      // `currentOwnerContactId` so a customer rule can refuse a takeover. It is
      // a hint, not a decision: the store re-reads it inside the pair lock.
      const liveOwner = await getLiveLink({
        db,
        provider: providerId,
        providerUserId: identity.providerUserId,
      });

      // (10) THE VETO, pre-write and fail-closed. On the COLD path
      // `ctx.contactId` is null and `anonymousId` is the key: no contact has
      // been resolved yet, deliberately, so a veto cannot leave a ghost contact
      // behind. `identity.tokens` exists only as a local from here on and is
      // handed to the store ONLY after this allows — LOAD-BEARING: hoisting a
      // token seal above this hook would persist grant material for a link the
      // customer refused.
      const warm = intent.contactId !== undefined;
      let contactFacts: { userId: string | null; email: string | null } = {
        userId: null,
        email: null,
      };
      if (warm) {
        const facts = await readContactFacts(db, intent.contactId as string);
        if (!facts) {
          // The sealed contact is gone (or soft-deleted) since the mint. A
          // state TTL is 15 minutes and a contact deletion unlinks everything
          // it owned (DECISIONS §15.3), so re-attaching here would resurrect a
          // link on a dead row — and `linked_accounts.contact_id` is a NOT NULL
          // FK, so the alternative is an unhandled 500 on a player's callback.
          logger.warn(
            "account link callback: the sealed contact no longer exists",
            { provider: providerId },
          );
          noteLinkFailed(fail, "state_invalid", null);
          return errorPage();
        }
        contactFacts = facts;
      }
      const beforeCtx: BeforeLinkContext = {
        provider: providerId,
        identity,
        contactId: warm ? (intent.contactId as string) : null,
        ...(warm ? {} : { anonymousId: intent.anonymousId }),
        userId: contactFacts.userId,
        email: contactFacts.email,
        // WARM only. On the cold path `intent.contactId` is undefined, so
        // `liveOwner.contactId !== intent.contactId` is true for EVERY live
        // owner — including the visitor's own contact. A consumer shipping the
        // documented takeover guard (`ctx.currentOwnerContactId ? refuse`)
        // would then veto a player re-linking an account they already own: link
        // cold, click Link again, get "we couldn't link your account" plus an
        // account.link_failed{vetoed} for a link they hold.
        //
        // Cold deliberately has no resolved contact at hook time (veto before
        // mint), so "a DIFFERENT owner" is unknowable here — and does not need
        // to be: cold passes `allowDisplaceLiveOwner: false`, so the store
        // itself refuses a real cold takeover with `live_owner_conflict`.
        ...(warm && liveOwner && liveOwner.contactId !== intent.contactId
          ? { currentOwnerContactId: liveOwner.contactId }
          : {}),
      };
      const verdict = await runBeforeLink({
        hooks: accountLinkHooks,
        ctx: beforeCtx,
        logger,
      });
      if (!verdict.allow) {
        // Return BEFORE the store call. Nothing is sealed, nothing is written,
        // and on the cold path no contact was ever resolved.
        noteLinkFailed(
          fail,
          "vetoed",
          warm ? (intent.contactId ?? null) : null,
        );
        return errorPage();
      }

      // (11) The contact side. WARM: the sealed id, used as is — the
      // provider-reported email is NEVER a resolution key (DECISIONS §6.3), it
      // rides `identity` into the store as a display property only.
      //
      // COLD: resolved HERE, strictly AFTER the veto and strictly BEFORE
      // `linkAccount` opens its pair-lock transaction —
      // `resolveOrCreateContact` takes its OWN contact-key advisory locks
      // (`lib/contacts.ts`), so calling it inside the pair lock reintroduces the
      // exact deadlock `unlinkAccountInTx` exists to avoid.
      let contactId: string;
      if (warm) {
        contactId = intent.contactId as string;
      } else {
        const anonymousId = intent.anonymousId;
        if (!anonymousId) {
          // An account_link state always carries exactly one binding; a state
          // with neither is malformed regardless of its signature.
          logger.warn("account link callback: state carries no binding", {
            provider: providerId,
          });
          noteLinkFailed(fail, "state_invalid", null);
          return errorPage();
        }
        try {
          // The `allowMerge: "anonymous-only"` clamp below stops a cold link
          // ATTACHING to an identified victim. It does NOT stop a cold link
          // MINTING a doppelganger, and that is the actual takeover:
          //
          //   victim: external_id = "user_42", anonymous_id NULL
          //   attacker: /start?anonymous_id=user_42, then proves THEIR steam
          //
          // No candidate matches (the victim's key lives in `external_id`), so
          // the clamp is never consulted and a NEW contact is inserted with
          // `anonymous_id = "user_42"`. Canonical key is
          // `external_id ?? anonymous_id ?? id`, so that row's `userId` IS the
          // victim's player id — and `afterLink` hands the publisher
          // `{ userId: "user_42", providerUserId: <attacker's steamid> }`. The
          // documented "grant the reward" integration then entitles the
          // attacker's Steam account as the victim. Same shape with the
          // victim's email when they carry no external_id.
          //
          // `collidesWithIdentified` is the guard the engine already ships for
          // the other token-less anon-id-accepting surfaces (feed/recipient.ts,
          // tracking/arrive.ts): it sees what the anonymous-only clamp cannot —
          // the value being a live contact's external_id or email, or a merged
          // loser's stale non-anonymous alias.
          if (await collidesWithIdentified(db, anonymousId)) {
            throw new PublishableAnonymousMergeError();
          }
          const resolved = await resolveOrCreateContact({
            db,
            anonymousId,
            // ALL THREE fields are spelled out because ALL THREE are required
            // and the DEFAULT is catastrophic here: no policy means
            // `allowMerge: "any"` with `trustedKinds: ALL_IDENTITY_KINDS`,
            // which FILLS IN a link onto whatever contact already owns that
            // anon alias — INCLUDING AN IDENTIFIED VICTIM'S. `anonymous_id`
            // arrives on an unauthenticated URL and is browser-readable by
            // design, so on the cold path the proof is of the PLATFORM
            // account, never of the contact (DECISIONS §6.10).
            policy: {
              // Minting here is legitimate and is NOT the ghost-contact case
              // `resolveContactNoCreate` exists for: a proven platform-account
              // link is an identity ASSERTION, not an observation. Cold Steam
              // is the sharp case — Steam yields no email ever, so the
              // resulting contact is anon-keyed until the player identifies,
              // at which point `adoptOrphanHistory` stamps their anon-keyed
              // history (the `linked_accounts` row itself needs nothing from
              // that path: `contact_id` is NOT NULL there, so it is a proven
              // no-op, and PRD 04's merge leg repoints the row). The clamp
              // that keeps this honest is `allowMerge`, not a refusal to
              // create.
              create: "on-miss",
              allowMerge: "anonymous-only",
              trustedKinds: ["anonymous"],
            },
          });
          contactId = resolved.id;
        } catch (err) {
          if (err instanceof PublishableAnonymousMergeError) {
            // A HARD REFUSAL. Not a fallback, not a retry with a fresh key,
            // not "mint a new contact instead": the only way to get here is an
            // `anonymous_id` naming a contact a cold flow may not touch.
            logger.warn(
              "account link callback: cold anonymous_id names a contact a " +
                "cold link may not attach to — refused",
              { provider: providerId },
            );
            noteLinkFailed(fail, "state_invalid", null);
            return errorPage();
          }
          throw err;
        }
      }

      // (12) The write. PRD 03's frozen `LinkAccountInput`, field for field.
      // `multiple` / `onConflict` / `storeTokens` come from the provider
      // definition with the CALLER applying the defaults, and
      // `allowDisplaceLiveOwner` is TRUE only on the WARM path — a cold link
      // may never take a platform account off its current owner, because the
      // contact side of a cold link is an anon id typed into an
      // unauthenticated URL.
      //
      // `hooks` is the container's, and passing it in is how the consumer's
      // post-commit hook runs BEFORE the success page renders: the STORE
      // invokes it, post-commit, inside this await. This route invokes no
      // post-commit hook itself (DECISIONS §15.4) — a second invoker would
      // fire every customer hook twice, and because the hooks are documented
      // at-least-once nothing would fail loudly. That is also why
      // `grep -rn "after" this directory finds no hook call: it is a
      // reviewable invariant, not a convention.
      const result = await linkAccount({
        db,
        provider: providerId,
        identity,
        contactId,
        method: "oauth",
        multiple: provider.multiple ?? true,
        onConflict: provider.onConflict ?? "replace",
        storeTokens: provider.capabilities?.tokens === true,
        allowDisplaceLiveOwner: warm,
        hooks: accountLinkHooks,
        logger,
      });

      if (result.status === "rejected") {
        logger.warn("account link callback: store refused the link", {
          provider: providerId,
          reason: result.reason,
        });
        return errorPage();
      }

      // (13) `account.linked` is emitted from HERE, the intent layer, off the
      // facts the store returned (including its `owner` block). The store never
      // emits — the `lib/groups.ts` precedent, DECISIONS §8/§15.7.
      //
      // `unchanged` is deliberately NOT an emit: the same contact re-proving
      // the same platform account is a display refresh, not a state
      // transition. It consumed no version, so an emit here would announce a
      // change that did not happen and (with no new version) would be deduped
      // against the previous one anyway.
      if (result.status !== "unchanged") noteLinked(fail, result);

      // (14) Land the player. `returnTo` is re-checked against the allowlist AT
      // REDIRECT TIME: the state proves we minted the value, not that it is
      // still permitted, and the allowlist can have been edited while the
      // player was on the provider's consent screen.
      if (intent.returnTo) {
        if (isAllowedReturnTo(intent.returnTo, accountLinkAllowedOrigins)) {
          return c.redirect(intent.returnTo, 302);
        }
        logger.warn(
          "account link callback: sealed return_to is no longer allowed — " +
            "falling back to the hosted success page",
          { provider: providerId },
        );
      }
      return c.html(accountLinkSuccessPage(provider.meta.name), 200);
    },
  );
}

/**
 * The contact's own facts for the pre-write hook context. `userId` is
 * `contactKey()` (`external_id ?? anonymous_id ?? id`) — the SAME definition
 * the outbound payloads and the SDK use, never raw `externalId` — and `email`
 * is the CONTACT's address, never the provider-reported one.
 *
 * Read here rather than handed over by the store because `beforeLink` runs
 * strictly BEFORE the store opens its transaction. The post-commit hook gets
 * these from the store's own in-transaction join instead (DECISIONS §15.5),
 * which is why only this one read exists here.
 */
async function readContactFacts(
  db: Database,
  contactId: string,
): Promise<{ userId: string | null; email: string | null } | null> {
  const [row] = await db
    .select({
      id: contacts.id,
      externalId: contacts.externalId,
      anonymousId: contacts.anonymousId,
      email: contacts.email,
    })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), isNull(contacts.deletedAt)))
    .limit(1);
  // NULL means "no live contact", which the caller turns into a refusal — not
  // a silent link onto a row that is gone.
  if (!row) return null;
  return {
    userId: row.externalId ?? row.anonymousId ?? row.id,
    email: row.email ?? null,
  };
}

/**
 * THE `account.link_failed` SITE (PRD 08 T4 fills in the `emitOutbound` call).
 *
 * One function rather than four inline blocks so every rejection path answers
 * with the same shape and PRD 08 has exactly one place to wire the emit. The
 * two invariants that are PRD 07's and must survive that wiring:
 *
 *  - `contactId` is the SEALED id when the state verified, and `null` when it
 *    did not — a state that failed verification carries nothing trustworthy.
 *  - it NEVER mints a contact (DECISIONS §8). Nothing here resolves anything.
 */
function noteLinkFailed(
  fail: FailureContext,
  reason: "denied" | "vetoed" | "exchange_failed" | "state_invalid",
  contactId: string | null,
): void {
  fail.logger.info("account link failed", {
    provider: fail.providerId,
    reason,
    contactId,
  });
  // TODO(PRD 08 T4): emit `account.link_failed` here — no dedupeKey (there is
  // no version, and two genuine failures are two genuine facts).
}

/**
 * THE `account.linked` SITE (PRD 08 T4 fills in the `emitOutbound` calls).
 *
 * On a relink this is TWO emits: `account.unlinked` for the displaced owner at
 * the LOWER version FIRST, then `account.linked` at the higher one. That order
 * is what makes a consumer's `incoming.version > stored.version` guard discard
 * a late unlink instead of permanently recording the wrong owner.
 */
function noteLinked(
  fail: FailureContext,
  result: Extract<
    Awaited<ReturnType<typeof linkAccount>>,
    { status: "linked" | "relinked" }
  >,
): void {
  fail.logger.info("account linked", {
    provider: fail.providerId,
    status: result.status,
    version: result.version,
    contactId: result.owner.contactId,
  });
  // TODO(PRD 08 T4): emit `account.unlinked` (relink only, lower version) then
  // `account.linked`, keyed `al:<provider>:<uid>:v<version>`.
}
