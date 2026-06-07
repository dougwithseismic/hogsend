import type { Database } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { resolveOrCreateContact } from "../../lib/contacts.js";
import { applyListMembership } from "../../lib/preferences.js";
import { errorSchema } from "../../lib/schemas.js";
import { getListRegistry } from "../../lists/registry-singleton.js";
import { listMembershipError } from "../_shared.js";

const listSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  defaultOptIn: z.boolean(),
});

const bodySchema = z.object({
  email: z.string().optional(),
  userId: z.string().optional(),
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Lists"],
  summary: "List defined email lists",
  description:
    "Returns the enabled, code-defined email lists (D3). Membership lives in `email_preferences.categories`; this only enumerates the catalog.",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ lists: z.array(listSummarySchema) }),
        },
      },
      description: "Enabled lists",
    },
  },
});

const subscribeRoute = createRoute({
  method: "post",
  path: "/{id}/subscribe",
  tags: ["Lists"],
  summary: "Subscribe a contact to a list",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: bodySchema } },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            list: z.string(),
            subscribed: z.literal(true),
          }),
        },
      },
      description: "Contact subscribed",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Missing recipient or no resolvable email",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Unknown list id",
    },
  },
});

const unsubscribeRoute = createRoute({
  method: "post",
  path: "/{id}/unsubscribe",
  tags: ["Lists"],
  summary: "Unsubscribe a contact from a list",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: bodySchema } },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            list: z.string(),
            subscribed: z.literal(false),
          }),
        },
      },
      description: "Contact unsubscribed",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Missing recipient or no resolvable email",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Unknown list id",
    },
  },
});

/**
 * The shared side-effect of subscribe + unsubscribe (identical apart from the
 * boolean polarity): validate the list id, guard identity, then resolve/create
 * the contact FIRST (mirroring /v1/contacts + /v1/events) so a real row (and
 * uuid id) exists — without it `resolveRecipient` returns the raw email as the
 * contactId fallback and `email_preferences.user_id` is written as the raw email
 * instead of the `external_id ?? contact.id` uuid, breaking risk-10 key
 * consistency.
 *
 * Returns a discriminated result the caller maps to a status: `unknown_list` /
 * `missing_identity` → 404 / 400; `failed` → 400 with the error message; `ok` →
 * the caller's literally-typed success body. The `valid()` reads stay in each
 * typed `.openapi()` handler; only the polarity-invariant work lives here.
 */
async function applyListSubscription(opts: {
  db: Database;
  id: string;
  email?: string;
  userId?: string;
  subscribed: boolean;
}): Promise<
  | { kind: "unknown_list" }
  | { kind: "missing_identity" }
  | { kind: "failed"; message: string }
  | { kind: "ok" }
> {
  const { db, id, email, userId, subscribed } = opts;

  if (!getListRegistry().has(id)) {
    return { kind: "unknown_list" };
  }

  if (!email && !userId) {
    return { kind: "missing_identity" };
  }

  try {
    await resolveOrCreateContact({ db, userId, email });
    await applyListMembership({
      db,
      userId,
      email,
      lists: { [id]: subscribed },
    });
  } catch (err) {
    return { kind: "failed", message: listMembershipError(err) };
  }

  return { kind: "ok" };
}

// The lists router does NOT re-apply auth internally — the data-plane prefix
// guards in `routes/index.ts` (decision #16) apply `requireApiKey` +
// `requireScope("ingest")` to `/v1/lists` (bare + `/*`) before requests reach
// this router. Mounting auth here too would double the middleware.
export const listsRouter = new OpenAPIHono<AppEnv>()
  .openapi(listRoute, (c) => {
    const lists = getListRegistry()
      .getEnabled()
      .map((l) => ({
        id: l.id,
        name: l.name,
        ...(l.description !== undefined ? { description: l.description } : {}),
        defaultOptIn: l.defaultOptIn,
      }));

    return c.json({ lists }, 200);
  })
  .openapi(subscribeRoute, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");
    const { email, userId } = c.req.valid("json");

    const result = await applyListSubscription({
      db,
      id,
      email,
      userId,
      subscribed: true,
    });
    if (result.kind === "unknown_list") {
      return c.json({ error: `Unknown list: ${id}` }, 404);
    }
    if (result.kind === "missing_identity") {
      return c.json({ error: "email or userId is required" }, 400);
    }
    if (result.kind === "failed") {
      return c.json({ error: result.message }, 400);
    }
    return c.json({ list: id, subscribed: true as const }, 200);
  })
  .openapi(unsubscribeRoute, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");
    const { email, userId } = c.req.valid("json");

    const result = await applyListSubscription({
      db,
      id,
      email,
      userId,
      subscribed: false,
    });
    if (result.kind === "unknown_list") {
      return c.json({ error: `Unknown list: ${id}` }, 404);
    }
    if (result.kind === "missing_identity") {
      return c.json({ error: "email or userId is required" }, 400);
    }
    if (result.kind === "failed") {
      return c.json({ error: result.message }, 400);
    }
    return c.json({ list: id, subscribed: false as const }, 200);
  });
