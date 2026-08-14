import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { getLiveLink, listLiveLinks } from "../../lib/account-links.js";
import { errorSchema } from "../../lib/schemas.js";
import { resolveAccountsContactId } from "./resolve.js";
import { linkedAccountSchema, serializeLinkedAccount } from "./serialize.js";
import { unlinkFromRoute } from "./unlink.js";

/**
 * The OPERATOR pull plane (PRD 09 T3/T4) — `GET /v1/accounts`,
 * `GET /v1/accounts/{provider}/{providerUserId}` and the `DELETE` beside it.
 *
 * SECRET KEY ONLY, guarded in `routes/index.ts` (this router re-applies no auth
 * of its own, exactly like `routes/groups/index.ts:250-255`). The reads are
 * strongly consistent and always the live row: this plane is what a customer
 * reconciles against, so it never serves a mirror (DECISIONS §3.2).
 *
 * Every read goes through the store's helpers; this module writes no SQL.
 */

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 200;

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Accounts"],
  summary: "List linked accounts",
  description:
    "SECRET API KEY + `accounts` scope. Live links only, newest first. Filter by `contactId`, `email` (the contact is resolved first) or `provider`; at least one is required. Paginate with `limit` (default 50, max 200) and `offset`. Never returns the sealed token blob.",
  request: {
    query: z.object({
      contactId: z.string().optional(),
      email: z.string().optional(),
      provider: z.string().optional(),
      limit: z.coerce.number().min(1).max(LIMIT_MAX).optional(),
      offset: z.coerce.number().min(0).optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ accounts: z.array(linkedAccountSchema) }),
        },
      },
      description: "Live links, newest first",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "No filter supplied",
    },
  },
});

const lookupRoute = createRoute({
  method: "get",
  path: "/{provider}/{providerUserId}",
  tags: ["Accounts"],
  summary: "Reverse lookup a platform account",
  description:
    "SECRET API KEY + `accounts` scope. Answers 'who owns this platform account RIGHT NOW' with the full operator row (`contactId`, `version`, `linkedAt`, `method`, `tokensRevokedAt`). An unlinked pair is history, not a live owner, and 404s.",
  request: {
    params: z.object({
      provider: z.string().min(1),
      providerUserId: z.string().min(1),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ account: linkedAccountSchema }),
        },
      },
      description: "The live link",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "No live link for this pair",
    },
  },
});

const unlinkRoute = createRoute({
  method: "delete",
  path: "/{provider}/{providerUserId}",
  tags: ["Accounts"],
  summary: "Unlink a platform account (operator)",
  description:
    'SECRET API KEY + `accounts` scope. The operator / reconciliation unlink — stamps `reason: "api"`, allocates a new `version` inside the store\'s advisory-locked transaction and emits exactly one `account.unlinked`. The player-facing revokes are `POST /v1/accounts/me/revoke` (primary) and the hosted manage page. Unknown pair ⇒ `{ unlinked: false }` with 200 and no emission.',
  request: {
    params: z.object({
      provider: z.string().min(1),
      providerUserId: z.string().min(1),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            unlinked: z.boolean(),
            /** Decimal STRING (DECISIONS §5.1). Absent when nothing changed. */
            version: z.string().optional(),
          }),
        },
      },
      description: "Unlink result",
    },
  },
});

export function registerAccountsListRoute(router: OpenAPIHono<AppEnv>) {
  router.openapi(listRoute, async (c) => {
    const { db } = c.get("container");
    const { contactId, email, provider, limit, offset } = c.req.valid("query");

    if (!contactId && !email && !provider) {
      return c.json({ error: "contactId, email or provider is required" }, 400);
    }

    let filterContactId: string | undefined;
    if (contactId || email) {
      const resolved = await resolveAccountsContactId(db, { contactId, email });
      // An unknown contact is an EMPTY answer, never an unfiltered one: falling
      // through with no contact filter would list every live link in the
      // deployment under a filter the caller believes narrowed it.
      if (!resolved) return c.json({ accounts: [] }, 200);
      filterContactId = resolved;
    }

    const rows = await listLiveLinks({
      db,
      ...(filterContactId ? { contactId: filterContactId } : {}),
      ...(provider ? { provider } : {}),
      limit: limit ?? LIMIT_DEFAULT,
      offset: offset ?? 0,
    });

    return c.json({ accounts: rows.map(serializeLinkedAccount) }, 200);
  });
}

export function registerAccountsLookupRoute(router: OpenAPIHono<AppEnv>) {
  router.openapi(lookupRoute, async (c) => {
    const { db } = c.get("container");
    // Hono decodes a path segment ONCE, and the SDK encodes once — so the value
    // here is byte-identical to the one the store wrote, reserved characters
    // and all.
    const { provider, providerUserId } = c.req.valid("param");

    const row = await getLiveLink({ db, provider, providerUserId });
    if (!row) {
      return c.json(
        { error: `No live link for ${provider}/${providerUserId}` },
        404,
      );
    }
    return c.json({ account: serializeLinkedAccount(row) }, 200);
  });
}

export function registerAccountsUnlinkRoute(router: OpenAPIHono<AppEnv>) {
  router.openapi(unlinkRoute, async (c) => {
    const { provider, providerUserId } = c.req.valid("param");

    const result = await unlinkFromRoute(c, {
      provider,
      providerUserId,
      reason: "api",
    });

    if (result.status !== "unlinked") return c.json({ unlinked: false }, 200);
    return c.json({ unlinked: true, version: result.version }, 200);
  });
}
