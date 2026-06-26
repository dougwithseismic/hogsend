import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import { type Database, emailPreferences } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import {
  resolveContact,
  resolveOrCreateContact,
  resolveRecipient,
  serializeContact,
  serializePrefs,
} from "../../lib/contacts.js";
import type { Logger } from "../../lib/logger.js";
import { emitOutbound } from "../../lib/outbound.js";
import { applyListMembership } from "../../lib/preferences.js";
import { errorSchema } from "../../lib/schemas.js";
import { getListRegistry } from "../../lists/registry-singleton.js";
import {
  gatePublishableIdentity,
  listMembershipError,
  requireIdentity,
} from "../_shared.js";

const listSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  defaultOptIn: z.boolean(),
  // The resolved opt-in state for the identity in the query (`categories[id] ??
  // defaultOptIn`). An anon / publishable / no-identity read degrades to
  // `defaultOptIn` (never leaks another contact's state — mirrors the
  // `/preferences` gate). This makes ONE catalog call power a preference matrix.
  subscribed: z.boolean(),
});

// `GET /` accepts the SAME identity query as `/preferences` so a single call can
// return the catalog WITH each list's resolved `subscribed`. Identity is
// OPTIONAL here (the catalog itself is always returned); when absent (or on a
// publishable key) every `subscribed` falls back to `defaultOptIn`.
const listQuerySchema = z.object({
  userId: z.string().optional(),
  email: z.string().optional(),
  anonymousId: z.string().optional(),
});

const bodySchema = z.object({
  email: z.string().optional(),
  userId: z.string().optional(),
  // Publishable-key identity assertion (§Phase 1). Ignored on the secret path.
  userToken: z.string().optional(),
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Lists"],
  summary: "List defined email lists",
  description:
    "Returns the enabled, code-defined email lists (D3) with each list's resolved `subscribed` state for the (optional) identity in the query. Membership lives in `email_preferences.categories`; this enumerates the catalog and folds in the contact's opt-in map in one call.",
  request: { query: listQuerySchema },
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

// STATIC `/preferences` read. MUST be registered before any `/:id` GET so the
// literal path wins matching (there is no `/:id` GET today, so order is safe
// regardless — but keep it adjacent to `GET /` to preserve that invariant).
const prefsQuerySchema = z.object({
  userId: z.string().optional(),
  email: z.string().optional(),
  anonymousId: z.string().optional(),
});

const prefsResponseSchema = z.object({
  categories: z.record(z.string(), z.boolean()),
  unsubscribedAll: z.boolean(),
});

const preferencesRoute = createRoute({
  method: "get",
  path: "/preferences",
  tags: ["Lists"],
  summary: "Read a contact's list/email preferences",
  description:
    "Returns `{ categories, unsubscribedAll }` for the resolved contact. Behind the publishable gate: a pk_ key may read anon-only (anonymousId) — a concrete `email`/`userId` read requires a verified userToken (v3).",
  request: { query: prefsQuerySchema },
  responses: {
    200: {
      content: { "application/json": { schema: prefsResponseSchema } },
      description: "The contact's list/email preferences",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Missing identity",
    },
    403: {
      content: { "application/json": { schema: errorSchema } },
      description: "Publishable key may not read a concrete identity",
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
    403: {
      content: { "application/json": { schema: errorSchema } },
      description:
        "Publishable key attempted to act on another identity without a verified userToken",
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
    403: {
      content: { "application/json": { schema: errorSchema } },
      description:
        "Publishable key attempted to act on another identity without a verified userToken",
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
  hatchet: HatchetClient;
  logger: Logger;
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
  const { db, hatchet, logger, id, email, userId, subscribed } = opts;

  if (!getListRegistry().has(id)) {
    return { kind: "unknown_list" };
  }

  if (!email && !userId) {
    return { kind: "missing_identity" };
  }

  try {
    const { id: contactId, created } = await resolveOrCreateContact({
      db,
      userId,
      email,
    });

    // INTENT-LAYER outbound emit (decision #3): the lists route emits
    // `contact.created` ONLY on first creation (a list flip is not a contact
    // property delta, so no `contact.updated`). Fire-and-forget after a read-back.
    if (created) {
      void resolveContact({ db, id: contactId })
        .then((row) => {
          if (!row) return;
          return emitOutbound({
            db,
            hatchet,
            logger,
            event: "contact.created",
            payload: serializeContact(row),
          });
        })
        .catch(logger.warn);
    }

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
  .openapi(listRoute, async (c) => {
    const { db } = c.get("container");
    const { userId, email } = c.req.valid("query");
    const enabled = getListRegistry().getEnabled();

    // Best-effort subscription enrichment. ONLY a secret key with a concrete
    // identity (email/userId) reads another contact's category map; a
    // publishable key — or an anon / no-identity read — degrades to
    // `defaultOptIn` (no leak, mirroring the `/preferences` 403 on a publishable
    // concrete read). Reuses the same `resolveRecipient` + `extId` lookup so the
    // catalog and the matrix stay one call.
    let categories: Record<string, boolean> = {};
    if ((userId || email) && !c.get("publishable")) {
      const recipient = await resolveRecipient({ db, userId, email });
      if (recipient) {
        const extId = recipient.externalId ?? recipient.contactId;
        const rows = await db
          .select()
          .from(emailPreferences)
          .where(
            and(
              eq(emailPreferences.userId, extId),
              eq(emailPreferences.email, recipient.email),
            ),
          )
          .limit(1);
        const row = rows[0];
        if (row) categories = serializePrefs(row).categories;
      }
    }

    const lists = enabled.map((l) => ({
      id: l.id,
      name: l.name,
      ...(l.description !== undefined ? { description: l.description } : {}),
      defaultOptIn: l.defaultOptIn,
      subscribed: categories[l.id] ?? l.defaultOptIn,
    }));

    return c.json({ lists }, 200);
  })
  .openapi(preferencesRoute, async (c) => {
    const { db } = c.get("container");
    const { userId, email } = c.req.valid("query");

    // Identity gate (publishable-aware). A secret key needs email/userId via
    // `requireIdentity`. A publishable key may read anon-only — but a concrete
    // `email`/`userId` read would leak another person's prefs, so it is rejected
    // unless v3's userToken arm is added. (`anonymousId` is accepted for a
    // publishable read; it never resolves to another identity's prefs here.)
    if (!c.get("publishable")) {
      const guard = requireIdentity(c, { email, userId });
      if (guard) return guard;
    } else if (email || userId) {
      return c.json(
        {
          error:
            "publishable preference reads are anon-only without a userToken",
        },
        403,
      );
    }

    const recipient = await resolveRecipient({ db, userId, email });
    if (!recipient) {
      return c.json({ categories: {}, unsubscribedAll: false }, 200);
    }
    // `email_preferences.user_id` is keyed on `external_id ?? contact.id`
    // (risk 10) — mirror `resolveRecipient`'s contactId fallback.
    const extId = recipient.externalId ?? recipient.contactId;
    const rows = await db
      .select()
      .from(emailPreferences)
      .where(
        and(
          eq(emailPreferences.userId, extId),
          eq(emailPreferences.email, recipient.email),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) {
      return c.json({ categories: {}, unsubscribedAll: false }, 200);
    }
    const prefs = serializePrefs(row);
    return c.json(
      { categories: prefs.categories, unsubscribedAll: prefs.unsubscribedAll },
      200,
    );
  })
  .openapi(subscribeRoute, async (c) => {
    const { db, hatchet, logger, env } = c.get("container");
    const { id } = c.req.valid("param");
    const { email, userId, userToken } = c.req.valid("json");

    const guard = gatePublishableIdentity(
      c,
      { email, userId, userToken },
      env.BETTER_AUTH_SECRET,
    );
    if (guard) return guard;

    const result = await applyListSubscription({
      db,
      hatchet,
      logger,
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
    const { db, hatchet, logger, env } = c.get("container");
    const { id } = c.req.valid("param");
    const { email, userId, userToken } = c.req.valid("json");

    const guard = gatePublishableIdentity(
      c,
      { email, userId, userToken },
      env.BETTER_AUTH_SECRET,
    );
    if (guard) return guard;

    const result = await applyListSubscription({
      db,
      hatchet,
      logger,
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
