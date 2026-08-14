import { randomBytes } from "node:crypto";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { isAllowedReturnTo } from "../../lib/account-link-origins.js";
import {
  generatePkcePair,
  storePkceVerifier,
} from "../../lib/account-link-pkce.js";
import { checkAccountLinkThrottle } from "../../lib/account-link-throttle.js";
import {
  signConnectorState,
  verifyConnectorState,
} from "../../lib/connector-state.js";
import { getRedisIfConnected } from "../../lib/redis.js";
import {
  accountLinkCallbackUrl,
  accountLinkClientIp,
  anonIdCookie,
} from "./shared.js";

/**
 * `GET /v1/accounts/:provider/start` — the public entry point of the hosted
 * flow. Unauthenticated BY CONSTRUCTION: it is a link a player clicks, in an
 * email, a DM or a page, and it carries no `Authorization` header. Anything it
 * trusts, it trusts because we SIGNED it.
 *
 * It resolves the binding (WARM: a sealed `contactId`; COLD: a browser
 * anonymous key), mints the one-attempt state and PKCE material, and 302s to
 * the provider's authorize URL. It writes nothing to the database — a link that
 * is never completed leaves no trace, which is also why `account.link_started`
 * was rejected (DECISIONS §8).
 */
export function registerAccountLinkStartRoute(router: OpenAPIHono<AppEnv>) {
  router.openapi(
    createRoute({
      method: "get",
      path: "/{provider}/start",
      tags: ["Account links"],
      summary: "Begin a hosted account link",
      request: {
        params: z.object({ provider: z.string() }),
        query: z.object({
          /** A pre-sealed WARM state from `mintAccountLinkUrl` (DECISIONS §15.2). */
          t: z.string().optional(),
          /** COLD binding. Minted here when absent. */
          anonymous_id: z.string().optional(),
          return_to: z.string().optional(),
        }),
      },
      responses: {
        302: { description: "Redirect to the provider's authorize URL" },
        400: { description: "Bad return_to / bad warm token" },
        404: { description: "Unknown provider" },
        429: { description: "Throttled" },
        500: { description: "Nonce collision" },
        503: { description: "Redis unavailable (fail closed)" },
      },
    }),
    async (c) => {
      const { provider: providerId } = c.req.valid("param");
      const query = c.req.valid("query");
      const container = c.get("container");
      const { accountLinkProviders, accountLinkAllowedOrigins, env, logger } =
        container;

      // (1) The provider must be REGISTERED. An unconfigured provider is
      // ABSENT, never present-but-disabled, so this is a plain 404.
      const provider = accountLinkProviders.get(providerId);
      if (!provider) return c.json({ error: "unknown_provider" }, 404);

      // (2) Redis, FAIL-CLOSED (DECISIONS §6.8). PKCE custody and the callback's
      // nonce burn both live in Redis, so serving this route without one would
      // hand out states that cannot be safely completed.
      if (!getRedisIfConnected()) {
        logger.error(
          "account link start refused: redis is not connected. The hosted " +
            "flow fails closed because the state nonce burn and PKCE custody " +
            "both live in redis. Set REDIS_URL",
          { provider: providerId },
        );
        return c.json({ error: "unavailable" }, 503);
      }

      // (3) Throttle, per IP, BEFORE anything is minted.
      const ip = accountLinkClientIp(c);
      const ipBudget = await checkAccountLinkThrottle({ surface: "start", ip });
      if (!ipBudget.ok) {
        return ipBudget.reason === "rate_limited"
          ? c.json({ error: "rate_limited" }, 429)
          : c.json({ error: "unavailable" }, 503);
      }

      // (4) `return_to`, against the ONE allowlist. Never `*`.
      let returnTo = query.return_to;
      if (returnTo !== undefined) {
        if (!isAllowedReturnTo(returnTo, accountLinkAllowedOrigins)) {
          logger.warn("account link start: return_to not allowed", {
            provider: providerId,
          });
          return c.json({ error: "return_to_not_allowed" }, 400);
        }
      }

      // (5) The binding. WARM = a sealed `contactId` we minted; COLD = a
      // browser anonymous key. A `?t=` that fails verification is a 400 and is
      // NEVER silently downgraded to a cold link — a downgrade would turn a
      // tampered warm token into an anonymous link that looks like it worked.
      let contactId: string | undefined;
      let anonymousId: string | undefined;
      let mintedAnonymousId = false;

      if (query.t !== undefined) {
        const check = verifyConnectorState(query.t, env.BETTER_AUTH_SECRET);
        const intent = check.valid ? check.intent : undefined;
        if (
          !intent ||
          intent.purpose !== "account_link" ||
          intent.providerId !== providerId ||
          !intent.contactId
        ) {
          logger.warn("account link start: invalid warm token", {
            provider: providerId,
            reason: check.reason ?? "wrong_purpose_or_provider",
          });
          return c.json({ error: "invalid_token" }, 400);
        }
        contactId = intent.contactId;

        // A `returnTo` that rode the warm token is re-checked, not trusted: the
        // allowlist can have been edited since the mint, and our signature
        // proves only that WE minted the value.
        if (returnTo === undefined && intent.returnTo !== undefined) {
          if (isAllowedReturnTo(intent.returnTo, accountLinkAllowedOrigins)) {
            returnTo = intent.returnTo;
          } else {
            logger.warn(
              "account link start: sealed return_to is no longer allowed — dropping it",
              { provider: providerId },
            );
          }
        }

        // The WARM per-contact budget, now that the contact is known. A
        // separate call on purpose: re-passing the IP would double-count it.
        const contactBudget = await checkAccountLinkThrottle({
          surface: "start",
          contactId,
        });
        if (!contactBudget.ok) {
          return contactBudget.reason === "rate_limited"
            ? c.json({ error: "rate_limited" }, 429)
            : c.json({ error: "unavailable" }, 503);
        }
      } else {
        const supplied = query.anonymous_id?.trim();
        if (supplied) {
          anonymousId = supplied;
        } else {
          // NOT a 400. Steam yields no email, ever, and DECISIONS §7 forbids
          // widening `IdentityKind` with a `steam` kind, so a browser anonymous
          // key is the ONLY thing a cold Steam link can key its contact on —
          // without this mint a cold link is keyless and cannot complete at
          // all. Minting server-side also keeps the key out of an attacker's
          // hands in the common (no-key) case. Same shape the browser SDK
          // generates, and set as a cookie below so the browser carries it.
          anonymousId = randomBytes(16).toString("base64url");
          mintedAnonymousId = true;
        }
      }

      // (6) The one-attempt nonce: the callback burns it, and PKCE custody is
      // keyed by it.
      const nonce = randomBytes(16).toString("base64url");

      // (7) PKCE, only for providers that declare it. Steam is OpenID 2.0 and
      // has no code to protect, so nothing is written for it — asserted by
      // test, because a stray key here would be a silent Redis leak per link.
      let codeChallenge: string | undefined;
      if (provider.capabilities?.pkce) {
        const pair = generatePkcePair();
        const stored = await storePkceVerifier(
          nonce,
          pair.verifier,
          env.ACCOUNT_LINK_STATE_TTL_SECONDS,
        );
        if (!stored) {
          // `SET NX` refused: either a nonce collision (astronomically
          // unlikely, and never silently overwritten) or Redis is gone. Both
          // are refusals — a PKCE provider without a stored verifier can only
          // complete an exchange that proves less than it claims to.
          logger.error("account link start: could not take PKCE custody", {
            provider: providerId,
          });
          return c.json({ error: "unavailable" }, 500);
        }
        codeChallenge = pair.challenge;
        // The VERIFIER is deliberately not logged, not sealed into the state,
        // and not put on the redirect. Only the challenge leaves this process.
      }

      // (8) Seal the attempt.
      const state = signConnectorState(
        {
          purpose: "account_link",
          providerId,
          ...(contactId ? { contactId } : {}),
          ...(anonymousId ? { anonymousId } : {}),
          ...(returnTo ? { returnTo } : {}),
          nonce,
        },
        env.BETTER_AUTH_SECRET,
        env.ACCOUNT_LINK_STATE_TTL_SECONDS,
      );

      // (9) Off to the provider. `authorizeUrl` may be async (PRD 01 types it
      // `string | Promise<string>`), so it is awaited.
      const location = await provider.authorizeUrl({
        state,
        redirectUri: accountLinkCallbackUrl(env.API_PUBLIC_URL, providerId),
        ...(codeChallenge ? { codeChallenge } : {}),
      });

      if (mintedAnonymousId && anonymousId) {
        c.header("set-cookie", anonIdCookie(anonymousId, env.API_PUBLIC_URL));
      }
      return c.redirect(location, 302);
    },
  );
}
