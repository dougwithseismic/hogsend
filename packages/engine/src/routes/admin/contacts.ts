import { contacts, emailPreferences } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import {
  contactSearchFilter,
  resolveContact,
  resolveOrCreateContact,
  serializeContact as serializeContactRow,
  serializePrefs,
} from "../../lib/contacts.js";
import { emitOutbound } from "../../lib/outbound.js";
import { getContactRevenue } from "../../lib/revenue.js";

const contactSchema = z.object({
  id: z.string(),
  externalId: z.string().nullable(),
  anonymousId: z.string().nullable(),
  email: z.string().nullable(),
  properties: z.record(z.string(), z.unknown()),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const preferencesSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    email: z.string(),
    unsubscribedAll: z.boolean(),
    suppressed: z.boolean(),
    bounceCount: z.number(),
    categories: z.record(z.string(), z.boolean()),
  })
  .nullable();

// Revenue rollup over the contact's valued events (`user_events.value`),
// grouped per currency — never summed across currencies.
const revenueSchema = z.object({
  totals: z.array(
    z.object({
      currency: z.string().nullable(),
      total: z.number(),
      count: z.number(),
    }),
  ),
  lastValuedAt: z.string().nullable(),
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin"],
  summary: "List contacts",
  request: {
    query: z.object({
      limit: z.coerce.number().min(1).max(100).default(50),
      offset: z.coerce.number().min(0).default(0),
      search: z.string().optional(),
      // Long-tail value filters (plan §4b.3): the "find my value customers"
      // query surface.
      minRevenue: z.coerce.number().optional(),
      dealStage: z
        .enum(["lead", "contacted", "survey_booked", "quoted", "sold", "lost"])
        .optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            contacts: z.array(contactSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
      description: "Paginated contact list",
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Admin"],
  summary: "Get contact by ID or externalId",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            contact: contactSchema,
            preferences: preferencesSchema,
            revenue: revenueSchema,
          }),
        },
      },
      description: "Contact with preferences and revenue rollup",
    },
    404: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Contact not found",
    },
  },
});

const createRoute_ = createRoute({
  method: "post",
  path: "/",
  tags: ["Admin"],
  summary: "Create or upsert a contact",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              externalId: z.string().min(1).optional(),
              email: z.string().email().optional(),
              properties: z.record(z.string(), z.unknown()).optional(),
            })
            .refine((b) => Boolean(b.externalId || b.email), {
              message: "Provide at least one of externalId or email",
            }),
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: z.object({ contact: contactSchema }),
        },
      },
      description: "Contact created or upserted",
    },
    400: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Missing identity (externalId or email required)",
    },
  },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Admin"],
  summary: "Update a contact",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            email: z.string().email().optional(),
            properties: z.record(z.string(), z.unknown()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ contact: contactSchema }),
        },
      },
      description: "Contact updated",
    },
    404: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Contact not found",
    },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Admin"],
  summary: "Delete a contact",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ deleted: z.boolean() }),
        },
      },
      description: "Contact deleted",
    },
    404: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Contact not found",
    },
  },
});

const serializeContact = (row: typeof contacts.$inferSelect) =>
  serializeContactRow(row, { includeAnonymousId: true });

export const contactsRouter = new OpenAPIHono<AppEnv>()
  .openapi(listRoute, async (c) => {
    const { db } = c.get("container");
    const { limit, offset, search, minRevenue, dealStage } =
      c.req.valid("query");

    const searchFilter = search ? contactSearchFilter(search) : undefined;

    // Valued events are keyed by the contact's canonical event key
    // (external_id ?? anonymous_id ?? id) — same precedence ingestEvent
    // resolves. Served by the partial user_events_valued_user_idx.
    const revenueFilter =
      minRevenue !== undefined
        ? sql`(
            select coalesce(sum(ue.value), 0)
            from user_events ue
            where ue.user_id = coalesce(${contacts.externalId}, ${contacts.anonymousId}, ${contacts.id}::text)
              and ue.value is not null
          ) >= ${minRevenue}`
        : undefined;
    const dealStageFilter = dealStage
      ? sql`exists (
          select 1 from deals d
          where d.contact_id = ${contacts.id}
            and d.canonical_stage = ${dealStage}
        )`
      : undefined;

    const where = and(
      isNull(contacts.deletedAt),
      ...(searchFilter ? [searchFilter] : []),
      ...(revenueFilter ? [revenueFilter] : []),
      ...(dealStageFilter ? [dealStageFilter] : []),
    );

    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(contacts)
        .where(where)
        .orderBy(desc(contacts.lastSeenAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: count() }).from(contacts).where(where),
    ]);

    return c.json(
      {
        contacts: rows.map(serializeContact),
        total: totalRows[0]?.count ?? 0,
        limit,
        offset,
      },
      200,
    );
  })
  .openapi(getRoute, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");

    const contact = await resolveContact({ db, id });
    if (!contact) {
      return c.json({ error: "Contact not found" }, 404);
    }

    // email_preferences.user_id uses external_id when present, else the contact
    // uuid as the deterministic fallback (risk 10 — email-only contacts).
    const [prefRows, revenue] = await Promise.all([
      db
        .select()
        .from(emailPreferences)
        .where(eq(emailPreferences.userId, contact.externalId ?? contact.id))
        .limit(1),
      // Valued events are keyed by the contact's canonical event key — the
      // same precedence ingestEvent resolves (`external ?? anon ?? id`).
      getContactRevenue({
        db,
        key: contact.externalId ?? contact.anonymousId ?? contact.id,
      }),
    ]);

    const prefs = prefRows[0] ? serializePrefs(prefRows[0]) : null;

    return c.json(
      { contact: serializeContact(contact), preferences: prefs, revenue },
      200,
    );
  })
  .openapi(createRoute_, async (c) => {
    const { db, hatchet, logger } = c.get("container");
    const body = c.req.valid("json");

    // Delegate to the identity resolver (D1): it upserts/merges on the provided
    // identity keys (externalId and/or email), so the hand-rolled existence
    // check + raw insert + 409 are gone (§5). Read the row back to serialize.
    const {
      id,
      created: wasCreated,
      linked,
      merged,
    } = await resolveOrCreateContact({
      db,
      userId: body.externalId,
      email: body.email,
      contactProperties: body.properties,
    });

    const created = await resolveContact({ db, id });
    if (!created) {
      throw new Error("Failed to create contact");
    }

    // INTENT-LAYER outbound emit (decision #3): admin upsert mirrors the public
    // route — `contact.created` on a real creation, `contact.updated` when an
    // existing contact was linked/merged with a non-empty property delta.
    const hadPropertyDelta = Boolean(
      body.properties && Object.keys(body.properties).length > 0,
    );
    if (wasCreated || (linked || merged ? hadPropertyDelta : false)) {
      void emitOutbound({
        db,
        hatchet,
        logger,
        event: wasCreated ? "contact.created" : "contact.updated",
        payload: serializeContactRow(created),
      }).catch(logger.warn);
    }

    return c.json({ contact: serializeContact(created) }, 201);
  })
  .openapi(updateRoute, async (c) => {
    const { db, hatchet, logger } = c.get("container");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const current = await resolveContact({ db, id });
    if (!current) {
      return c.json({ error: "Contact not found" }, 404);
    }

    const hasIdentityKey = Boolean(
      current.externalId || current.anonymousId || body.email || current.email,
    );

    if (hasIdentityKey) {
      // Delegate the email-fill + property merge to the resolver, keyed on the
      // contact's canonical identity so the COALESCE||patch merge lives in one
      // place (§5). Passing the existing externalId/anonymousId/email keeps the
      // resolver on the fill-in-link path; a NEW email that already belongs to
      // another contact correctly merges (the partial-unique index would have
      // rejected a blind set anyway).
      await resolveOrCreateContact({
        db,
        userId: current.externalId ?? undefined,
        email: body.email ?? current.email ?? undefined,
        anonymousId: current.anonymousId ?? undefined,
        contactProperties: body.properties,
      });
    } else {
      // Degenerate contact with no identity keys (resolver requires >=1 key):
      // update it directly by uuid.
      await db
        .update(contacts)
        .set({
          ...(body.properties
            ? {
                properties: sql`COALESCE(${contacts.properties}, '{}'::jsonb) || ${JSON.stringify(body.properties)}::jsonb`,
              }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(contacts.id, current.id));
    }

    const updated = await resolveContact({ db, id });
    if (!updated) {
      throw new Error("Failed to update contact");
    }

    // INTENT-LAYER outbound emit (decision #3): the admin update is an explicit
    // edit — emit `contact.updated` on a non-empty property delta or a filled
    // email (a newly-attached identity). Fire-and-forget; the serialized updated
    // row is the catalog payload.
    const hadPropertyDelta = Boolean(
      body.properties && Object.keys(body.properties).length > 0,
    );
    const filledEmail = Boolean(body.email && body.email !== current.email);
    if (hadPropertyDelta || filledEmail) {
      void emitOutbound({
        db,
        hatchet,
        logger,
        event: "contact.updated",
        payload: serializeContactRow(updated),
      }).catch(logger.warn);
    }

    return c.json({ contact: serializeContact(updated) }, 200);
  })
  .openapi(deleteRoute, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");

    const contact = await resolveContact({ db, id });
    if (!contact) {
      return c.json({ error: "Contact not found" }, 404);
    }

    await db
      .update(contacts)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(contacts.id, contact.id));

    return c.json({ deleted: true }, 200);
  });
