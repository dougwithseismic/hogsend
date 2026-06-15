import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import {
  findContacts,
  resolveContact,
  resolveOrCreateContact,
  serializeContact,
  softDeleteContact,
} from "../../lib/contacts.js";
import { emitOutbound } from "../../lib/outbound.js";
import { applyListMembership } from "../../lib/preferences.js";
import { errorSchema } from "../../lib/schemas.js";
import { listMembershipError, requireIdentity } from "../_shared.js";

// The public, serialized contact shape (§2.5). `externalId` is nullable (D1 —
// email-only / anonymous contacts) and timestamps are ISO strings.
const contactSchema = z.object({
  id: z.string(),
  externalId: z.string().nullable(),
  email: z.string().nullable(),
  properties: z.record(z.string(), z.unknown()),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const upsertRoute = createRoute({
  method: "put",
  path: "/",
  tags: ["Contacts"],
  summary: "Upsert a contact",
  description:
    "Resolves (create / fill-in-link / merge) a contact by email and/or userId, applies contactProperties, and optionally writes list membership.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            email: z.string().email().optional(),
            userId: z.string().min(1).optional(),
            // §4: caller's analytics anon id — the resolver's 2nd-precedence
            // key. An EXTRA, never a third identity arm: `requireIdentity`
            // still requires email or userId below.
            anonymousId: z.string().min(1).max(200).optional(),
            properties: z.record(z.string(), z.unknown()).optional(),
            lists: z.record(z.string(), z.boolean()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            id: z.string(),
            created: z.boolean(),
            linked: z.boolean(),
          }),
        },
      },
      description: "Contact resolved",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Missing recipient or unmanageable list membership",
    },
  },
});

const findRoute = createRoute({
  method: "get",
  path: "/find",
  tags: ["Contacts"],
  summary: "Find contacts by email or userId",
  request: {
    query: z.object({
      email: z.string().optional(),
      userId: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ contacts: z.array(contactSchema) }),
        },
      },
      description: "Matching contacts (non-deleted)",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Missing query key",
    },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/",
  tags: ["Contacts"],
  summary: "Soft-delete a contact",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
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
          schema: z.object({ deleted: z.literal(true) }),
        },
      },
      description: "Contact soft-deleted",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Missing recipient key",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Contact not found",
    },
  },
});

export const contactsRouter = new OpenAPIHono<AppEnv>()
  .openapi(upsertRoute, async (c) => {
    const { db, hatchet, logger } = c.get("container");
    const body = c.req.valid("json");

    const guard = requireIdentity(c, body);
    if (guard) return guard;

    const { id, created, linked, merged } = await resolveOrCreateContact({
      db,
      userId: body.userId,
      email: body.email,
      // §4: 2nd-precedence resolver key (zero-merge stitch). Identity is still
      // enforced via `requireIdentity` (email/userId) above.
      anonymousId: body.anonymousId,
      contactProperties: body.properties,
    });

    // INTENT-LAYER outbound emit (decision #3): fire `contact.created` on a real
    // creation, `contact.updated` only when an existing contact was linked/merged
    // AND the request carried a non-empty property delta — NEVER inside
    // `resolveOrCreateContact` (which runs on every event → would emit on every
    // pageview). The emit is fire-and-forget; a read-back serializes the full
    // contact payload the catalog expects.
    const hadPropertyDelta = Boolean(
      body.properties && Object.keys(body.properties).length > 0,
    );
    if (created || (linked || merged ? hadPropertyDelta : false)) {
      const event = created ? "contact.created" : "contact.updated";
      void resolveContact({ db, id })
        .then((row) => {
          if (!row) return;
          return emitOutbound({
            db,
            hatchet,
            logger,
            event,
            payload: serializeContact(row),
          });
        })
        .catch(logger.warn);
    }

    // Lists applied AFTER the resolve so the contact exists (§2.5 lists
    // ordering). `applyListMembership` requires a resolvable email — surface the
    // "no email" case as a 400 rather than a 500.
    if (body.lists && Object.keys(body.lists).length > 0) {
      try {
        await applyListMembership({
          db,
          userId: body.userId,
          email: body.email,
          lists: body.lists,
        });
      } catch (err) {
        return c.json({ error: listMembershipError(err) }, 400);
      }
    }

    return c.json({ id, created, linked }, 200);
  })
  .openapi(findRoute, async (c) => {
    const { db } = c.get("container");
    const { email, userId } = c.req.valid("query");

    const guard = requireIdentity(c, { email, userId });
    if (guard) return guard;

    const rows = await findContacts({ db, email, userId });

    return c.json({ contacts: rows.map((row) => serializeContact(row)) }, 200);
  })
  .openapi(deleteRoute, async (c) => {
    const { db, hatchet, logger } = c.get("container");
    const { email, userId } = c.req.valid("json");

    const guard = requireIdentity(c, { email, userId });
    if (guard) return guard;

    const result = await softDeleteContact({ db, email, userId });
    if (!result.deleted) {
      return c.json({ error: "Contact not found" }, 404);
    }

    // The widened `softDeleteContact` returns the deleted row's identity so the
    // `contact.deleted` outbound webhook carries it without a second read-back.
    if (result.id) {
      void emitOutbound({
        db,
        hatchet,
        logger,
        event: "contact.deleted",
        payload: {
          id: result.id,
          externalId: result.externalId ?? null,
          email: result.email ?? null,
        },
      }).catch(logger.warn);
    }

    return c.json({ deleted: true as const }, 200);
  });
