import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { checkAccountLinkThrottle } from "../../lib/account-link-throttle.js";
import {
  AccountLinkReturnToError,
  mintAccountLinkUrl,
} from "../../lib/account-link-url.js";
import { errorSchema } from "../../lib/schemas.js";
import {
  InvalidUserTokenError,
  verifyUserToken,
} from "../../lib/user-token.js";
import { resolveAccountsContactId, resolveTokenContactId } from "./resolve.js";

/**
 * THE TWO MINTS (PRD 09 T6/T7). Both return the SAME thing: an ENGINE-ORIGIN
 * `<API_PUBLIC_URL>/v1/accounts/<provider>/start?t=<state>` URL, never a
 * provider authorize URL (DECISIONS §15.2). PRD 13's embed derives its
 * `postMessage` `expectedOrigin` from this value, so a provider-origin URL here
 * would make every embedded link TIME OUT while the link had committed
 * server-side — and a fake-`Window` test cannot see that.
 *
 * They differ in ONE thing, which is the whole security boundary:
 *
 *  - `POST /mint-link` is SECRET-key + `accounts` scope, and may seal ANY
 *    contact. Server-trusted, exactly like `resolveFeedRecipient`'s secret arm.
 *  - `POST /link-url` is browser-reachable, and seals ONLY the contact the
 *    verified `userToken` names (DECISIONS §6.5). A `contactId`, `email` or
 *    differing `userId` in the body is a 403 with NO MINT — browsers can never
 *    mint for an arbitrary contact, whatever key tier they hold.
 *
 * Both are throttled through the Redis INCR helper and both FAIL CLOSED: a
 * rejected budget AND an unavailable Redis are a `429` with no URL
 * (DECISIONS §6.8). A mint that succeeded while Redis was down would hand out a
 * state the hosted `/start` and `/callback` will then refuse anyway — those
 * routes need Redis for PKCE custody and the single-use nonce burn.
 */

const mintResponse = z.object({
  url: z.string(),
  /** When the sealed state stops being accepted by `/start`. */
  expiresAt: z.string(),
});

const mintLinkRoute = createRoute({
  method: "post",
  path: "/mint-link",
  tags: ["Accounts"],
  summary: "Mint a hosted link URL for a contact (operator)",
  description:
    "SECRET API KEY + `accounts` scope. Seals the named contact into an `account_link` state and returns the ENGINE-origin `/v1/accounts/<provider>/start?t=<state>` URL — never the provider's authorize URL. Use this to put a link button in an email or a DM. The browser equivalent is `POST /v1/accounts/link-url`, which can only ever mint for the `userToken`'s own user.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            provider: z.string().min(1),
            contactId: z.string().optional(),
            email: z.string().optional(),
            returnTo: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: mintResponse } },
      description: "The hosted link URL",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "No contact key, or an off-allowlist returnTo",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Unknown provider or unknown contact",
    },
    429: {
      content: { "application/json": { schema: errorSchema } },
      description: "Throttled, or Redis unavailable (fail closed)",
    },
  },
});

const linkUrlRoute = createRoute({
  method: "post",
  path: "/link-url",
  tags: ["Accounts"],
  summary: "Mint a hosted link URL for the signed-in player",
  description:
    "Publishable OR secret key, plus a server-minted `userToken`. THE DX UNLOCK: the customer's browser calls this directly, so they ship no backend endpoint of their own. Mints ONLY for the token's `userId`; a `contactId`, `email` or differing `userId` in the body is a 403 and nothing is minted. Returns the same ENGINE-origin `/start?t=` URL as `mint-link`.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            provider: z.string().min(1),
            userToken: z.string().optional(),
            returnTo: z.string().optional(),
            // Declared so they can be REFUSED — a zod object strips unknown
            // keys, so an undeclared `contactId` would be silently dropped and
            // the 403 could never fire.
            contactId: z.string().optional(),
            email: z.string().optional(),
            userId: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: mintResponse } },
      description: "The hosted link URL",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "An off-allowlist returnTo",
    },
    403: {
      content: { "application/json": { schema: errorSchema } },
      description: "Missing/invalid userToken, or a body naming an identity",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Unknown provider, or the token names no contact",
    },
    429: {
      content: { "application/json": { schema: errorSchema } },
      description: "Throttled, or Redis unavailable (fail closed)",
    },
  },
});

export function registerAccountsMintLinkRoute(router: OpenAPIHono<AppEnv>) {
  router.openapi(mintLinkRoute, async (c) => {
    const { accountLinkAllowedOrigins, accountLinkProviders, db, env } =
      c.get("container");
    const body = c.req.valid("json");

    if (!accountLinkProviders.get(body.provider)) {
      return c.json({ error: "unknown_provider" }, 404);
    }
    if (!body.contactId && !body.email) {
      return c.json({ error: "contactId or email is required" }, 400);
    }

    const contactId = await resolveAccountsContactId(db, {
      contactId: body.contactId,
      email: body.email,
    });
    // No contact ⇒ no mint. Minting for a contact that does not exist would
    // seal an id the callback then refuses (the FK is NOT NULL), so the player
    // would walk the whole provider flow to reach an error page.
    if (!contactId) return c.json({ error: "unknown_contact" }, 404);

    const budget = await checkAccountLinkThrottle({
      surface: "start",
      contactId,
    });
    if (!budget.ok) return c.json({ error: budget.reason }, 429);

    const minted = buildMintedUrl({
      provider: body.provider,
      contactId,
      returnTo: body.returnTo,
      allowedOrigins: accountLinkAllowedOrigins,
      apiPublicUrl: env.API_PUBLIC_URL,
      ttlSeconds: env.ACCOUNT_LINK_STATE_TTL_SECONDS,
    });
    if (!minted) return c.json({ error: "return_to_not_allowed" }, 400);
    return c.json(minted, 200);
  });
}

export function registerAccountsLinkUrlRoute(router: OpenAPIHono<AppEnv>) {
  router.openapi(linkUrlRoute, async (c) => {
    const { accountLinkAllowedOrigins, accountLinkProviders, db, env } =
      c.get("container");
    const body = c.req.valid("json");

    // (1) A body that names an identity is refused BEFORE the token is even
    // read. The contact sealed into the state comes from the token, never from
    // the request (DECISIONS §6.3/§6.5), so a request that argues otherwise is
    // malformed regardless of whether its token is valid.
    if (body.contactId || body.email) {
      return c.json(
        { error: "userToken does not authorize this identity" },
        403,
      );
    }

    // (2) The token. Absent, malformed, expired or badly signed are ONE answer:
    // 403, no mint. (Unlike `/me`, this route is not an existence oracle — it
    // performs an action, so it may refuse out loud.)
    if (!body.userToken) {
      return c.json({ error: "Invalid userToken" }, 403);
    }
    let tokenUserId: string;
    try {
      tokenUserId = verifyUserToken({
        token: body.userToken,
        secret: env.BETTER_AUTH_SECRET,
      }).userId;
    } catch (err) {
      if (err instanceof InvalidUserTokenError) {
        return c.json({ error: "Invalid userToken" }, 403);
      }
      throw err;
    }
    if (body.userId && body.userId !== tokenUserId) {
      return c.json(
        { error: "userToken does not authorize this identity" },
        403,
      );
    }

    if (!accountLinkProviders.get(body.provider)) {
      return c.json({ error: "unknown_provider" }, 404);
    }

    const contactId = await resolveTokenContactId(db, tokenUserId);
    if (!contactId) return c.json({ error: "unknown_contact" }, 404);

    const budget = await checkAccountLinkThrottle({
      surface: "start",
      contactId,
    });
    if (!budget.ok) return c.json({ error: budget.reason }, 429);

    const minted = buildMintedUrl({
      provider: body.provider,
      contactId,
      returnTo: body.returnTo,
      allowedOrigins: accountLinkAllowedOrigins,
      apiPublicUrl: env.API_PUBLIC_URL,
      ttlSeconds: env.ACCOUNT_LINK_STATE_TTL_SECONDS,
    });
    if (!minted) return c.json({ error: "return_to_not_allowed" }, 400);
    return c.json(minted, 200);
  });
}

/**
 * The one place either route builds its URL, so the two cannot drift on the
 * shape or on the `returnTo` refusal.
 *
 * `null` means the `returnTo` was off the allowlist — a 400 at both call sites,
 * NEVER a silent fallback to the hosted page: an open redirect on a link flow
 * is a phishing primitive, and one we would have SIGNED.
 */
function buildMintedUrl(args: {
  provider: string;
  contactId: string;
  returnTo?: string;
  allowedOrigins: string[];
  apiPublicUrl: string;
  ttlSeconds: number;
}): { url: string; expiresAt: string } | null {
  let url: string;
  try {
    url = mintAccountLinkUrl({
      provider: args.provider,
      contactId: args.contactId,
      ...(args.returnTo ? { returnTo: args.returnTo } : {}),
      allowedOrigins: args.allowedOrigins,
      apiPublicUrl: args.apiPublicUrl,
      ttlSeconds: args.ttlSeconds,
    });
  } catch (err) {
    if (err instanceof AccountLinkReturnToError) return null;
    throw err;
  }
  return {
    url,
    expiresAt: new Date(Date.now() + args.ttlSeconds * 1000).toISOString(),
  };
}
