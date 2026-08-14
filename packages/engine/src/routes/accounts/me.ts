import type { Database } from "@hogsend/db";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { listLiveLinks } from "../../lib/account-links.js";
import { errorSchema } from "../../lib/schemas.js";
import {
  InvalidUserTokenError,
  verifyUserToken,
} from "../../lib/user-token.js";
import { resolveTokenContactId } from "./resolve.js";
import {
  publicLinkedAccountSchema,
  serializePublicLinkedAccount,
} from "./serialize.js";
import { unlinkFromRoute } from "./unlink.js";

/**
 * THE PLAYER'S OWN TWO ROUTES (PRD 09 T8/T8b), both `userToken`-gated and both
 * NON-CONFIRMING (DECISIONS §6.9/§14).
 *
 * A player signed in on the publisher's site already has a server-minted
 * `userToken` for the rest of the SDK, so the in-app path needs no email, no
 * hosted page and no token in a URL. PRD 11's hosted manage page is the
 * FALLBACK for a player with no session; the secret-key `DELETE` is the
 * operator path and is neither.
 *
 * **Non-confirmation is the whole design.** An absent, malformed, expired,
 * forged or unknown-user token takes the SAME code path as "you exist and hold
 * nothing": one `return` shape per handler, no `401`, no `403`, no `404` and no
 * varying error body. Anything else lets a caller enumerate which players a
 * publisher has and which platform accounts they hold.
 *
 * The one `403` here is a different case entirely: a body that tries to NAME an
 * identity is a malformed REQUEST, not a question about whether a contact
 * exists (the same rule as `POST /v1/accounts/link-url`).
 */

/**
 * A `multiple: true` provider can hold many links per contact; both routes are
 * bounded so a read and a revoke are finite.
 */
const MAX_ROWS = 500;

const meRoute = createRoute({
  method: "get",
  path: "/me",
  tags: ["Accounts"],
  summary: "List the signed-in player's linked accounts",
  description:
    "Publishable OR secret key, plus a server-minted `userToken` in the query string. Returns DISPLAY FIELDS ONLY (`provider`, `username`, `avatarUrl`, `linkedAt`) — never `providerUserId`, `contactId`, `version` or `method`. NON-CONFIRMING: an absent, forged, expired or unknown-user token returns `200 { accounts: [] }`, byte-identical to a real user with no links.",
  request: {
    query: z.object({ userToken: z.string().optional() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            accounts: z.array(publicLinkedAccountSchema),
          }),
        },
      },
      description: "The player's live links (possibly empty)",
    },
  },
});

const revokeRoute = createRoute({
  method: "post",
  path: "/me/revoke",
  tags: ["Accounts"],
  summary: "Unlink the signed-in player's accounts for one provider",
  description:
    'Publishable OR secret key, plus a server-minted `userToken`. THE PRIMARY player unlink. Unlinks every live link the token\'s contact holds for `provider` with `reason: "player"`, each at its own new version under its own advisory lock, each emitting one `account.unlinked`. Keyed on `provider`, not `providerUserId`, because `GET /v1/accounts/me` deliberately returns no id. NON-CONFIRMING: a token problem returns `200 { revoked: 0 }`. A body naming an identity (`contactId`/`email`/a foreign `userId`) is a 403 — ownership comes from the token, never the body.',
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            provider: z.string().min(1),
            userToken: z.string().optional(),
            // Declared so they can be REFUSED. A zod object strips unknown
            // keys, so an undeclared `contactId` would be silently dropped and
            // the 403 below could never fire.
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
      content: {
        "application/json": {
          schema: z.object({ revoked: z.number() }),
        },
      },
      description: "How many live links were unlinked (possibly zero)",
    },
    403: {
      content: { "application/json": { schema: errorSchema } },
      description: "The body tried to name an identity",
    },
  },
});

/**
 * The token's contact, or `null` for EVERY failure mode. Deliberately
 * indistinguishable: a bad signature, an expired token and a userId nobody
 * owns all answer the same way.
 */
async function contactFromToken(
  db: Database,
  secret: string,
  token: string | undefined,
): Promise<string | null> {
  if (!token) return null;
  try {
    const { userId } = verifyUserToken({ token, secret });
    return await resolveTokenContactId(db, userId);
  } catch (err) {
    if (err instanceof InvalidUserTokenError) return null;
    throw err;
  }
}

export function registerAccountsMeRoute(router: OpenAPIHono<AppEnv>) {
  router.openapi(meRoute, async (c) => {
    const { db, env } = c.get("container");
    // A GET has no body; the feed routes read the token from the query the same
    // way (`routes/feed/recipient.ts:44-49`).
    const { userToken } = c.req.valid("query");

    const contactId = await contactFromToken(
      db,
      env.BETTER_AUTH_SECRET,
      userToken,
    );
    const rows = contactId
      ? await listLiveLinks({ db, contactId, limit: MAX_ROWS })
      : [];

    // ONE return shape in this handler. Verification failure and "no such
    // contact" reach it having built an empty array, so the response is
    // byte-identical to a real user with no links.
    return c.json({ accounts: rows.map(serializePublicLinkedAccount) }, 200);
  });
}

export function registerAccountsMeRevokeRoute(router: OpenAPIHono<AppEnv>) {
  router.openapi(revokeRoute, async (c) => {
    const { db, env } = c.get("container");
    const body = c.req.valid("json");

    // A body that names an identity is REFUSED before anything else. This is
    // about the request being malformed, not about whether a contact exists,
    // so it is the one non-200 on this route.
    if (body.contactId || body.email) {
      return c.json(
        { error: "userToken does not authorize this identity" },
        403,
      );
    }

    const contactId = await contactFromToken(
      db,
      env.BETTER_AUTH_SECRET,
      body.userToken,
    );
    if (contactId && body.userId) {
      // A `userId` is only tolerable when it is the token's own subject; the
      // token is still what decides, and a mismatch is the same refusal.
      const claimed = await resolveTokenContactId(db, body.userId);
      if (claimed !== contactId) {
        return c.json(
          { error: "userToken does not authorize this identity" },
          403,
        );
      }
    }
    if (!contactId) {
      // Non-confirming: no token, a forged one, or a user nobody owns — all
      // answer exactly as "you hold nothing for this provider".
      return c.json({ revoked: 0 }, 200);
    }

    const rows = await listLiveLinks({
      db,
      contactId,
      provider: body.provider,
      limit: MAX_ROWS,
    });

    let revoked = 0;
    for (const row of rows) {
      // `expectContactId` is NOT a duplicate of the enumeration above: that
      // ran outside the pair lock, and a hosted callback can relink the pair
      // between the read and the write. The store re-checks ownership INSIDE
      // the lock and returns `rejected: not_owner` instead of destroying the
      // new owner's just-proven link. A rejection is simply not counted —
      // never a 403, never a 404.
      const result = await unlinkFromRoute(c, {
        provider: row.provider,
        providerUserId: row.providerUserId,
        reason: "player",
        expectContactId: contactId,
      });
      if (result.status === "unlinked") revoked++;
    }

    return c.json({ revoked }, 200);
  });
}
