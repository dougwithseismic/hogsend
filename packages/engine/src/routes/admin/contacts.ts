import {
  contacts,
  emailPreferences,
  groupMemberships,
  groups,
} from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, asc, count, desc, eq, isNull, not, sql } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { emitAccountUnlinked } from "../../lib/account-link-emit.js";
import { unlinkAccountsForContactInTx } from "../../lib/account-links.js";
import {
  ALL_IDENTITY_KINDS,
  contactKeySql,
  contactSearchFilter,
  deleteIdentityAliasesForContact,
  identifiedContactFilter,
  resolveContact,
  resolveOrCreateContact,
  serializeContact as serializeContactRow,
  serializePrefs,
} from "../../lib/contacts.js";
import { emitOutbound } from "../../lib/outbound.js";
import { getContactRevenue, revenueExcludedEvents } from "../../lib/revenue.js";

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

// The contact's live group memberships (`group_memberships` joined to `groups`),
// each linking to that group's Studio page. A contact is many-to-many with
// groups; soft-deleted groups are excluded.
const contactGroupSchema = z.object({
  groupType: z.string(),
  groupKey: z.string(),
  displayName: z.string().nullable(),
  role: z.string().nullable(),
  joinedAt: z.string(),
});

/**
 * PRD 06 — validation gate for a jsonb property key used in ordering or
 * filtering. This is a REJECTION layer only: the key is additionally ALWAYS
 * bound as a SQL parameter in the query builder (never interpolated), so the
 * two layers are independent defences, not substitutes for each other.
 */
const PROPERTY_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin"],
  summary: "List contacts",
  description:
    "Paginated contact list. `identity` narrows the list by whether the " +
    "contact has EVER identified — i.e. holds an `externalId`, `email`, " +
    "`discordId` or `phone` (`anonymousId` alone does not count). It " +
    "defaults to `all`, so existing callers (`hogsend contacts list`, the " +
    "Studio contact picker) are unaffected; only Studio's contacts screen " +
    "opts in to `identified`. `identified` and `anonymous` are exact " +
    "complements under the same other filters, and `total` reflects the " +
    "filter.",
  request: {
    query: z
      .object({
        limit: z.coerce.number().min(1).max(100).default(50),
        offset: z.coerce.number().min(0).default(0),
        search: z.string().optional(),
        /**
         * Display filter (PRD 01) over "has this person ever identified?".
         *
         * The default is `all` ON PURPOSE and must stay that way: two
         * consumers other than Studio's contacts list call this route and
         * neither should silently change — the published `hogsend contacts
         * list` CLI (output is scripted against) and Studio's contact
         * picker (an anonymous contact is a legitimate pick when a journey
         * or test is aimed at an anon key). Flipping this default is an
         * API behaviour change, not a display tweak.
         */
        identity: z.enum(["all", "identified", "anonymous"]).default("all"),
        // Long-tail value filters (plan §4b.3): the "find my value customers"
        // query surface.
        minRevenue: z.coerce.number().optional(),
        // Plain string: valid stages are the deployment's configured ladder.
        dealStage: z.string().optional(),
        // Leaderboard surface (PRD 06): rank contacts by the NUMERIC value of
        // a jsonb property ("who do I call today"). Defaults reproduce the
        // pre-existing behaviour exactly (ORDER BY last_seen_at DESC).
        orderBy: z
          .enum(["lastSeenAt", "firstSeenAt", "property"])
          .default("lastSeenAt"),
        orderProperty: z.string().regex(PROPERTY_KEY_RE).optional(),
        orderDir: z.enum(["asc", "desc"]).default("desc"),
        // Numeric property filter: only contacts whose value at `propertyKey`
        // is a real JSON number ≥ `propertyGte`. Composable with ordering.
        propertyKey: z.string().regex(PROPERTY_KEY_RE).optional(),
        propertyGte: z.coerce.number().optional(),
      })
      .refine(
        (q) => q.orderBy !== "property" || q.orderProperty !== undefined,
        {
          message: "orderProperty is required when orderBy=property",
        },
      )
      .refine(
        (q) => q.propertyGte === undefined || q.propertyKey !== undefined,
        {
          message: "propertyKey is required when propertyGte is set",
        },
      ),
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
    400: {
      content: {
        "application/json": {
          // zod-openapi's default validation hook shape (ZodError passthrough).
          schema: z.object({ success: z.boolean() }).passthrough(),
        },
      },
      description:
        "Invalid query (bad property key, or orderBy=property without orderProperty)",
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
            groups: z.array(contactGroupSchema),
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
    const {
      limit,
      offset,
      search,
      identity,
      minRevenue,
      dealStage,
      orderBy,
      orderProperty,
      orderDir,
      propertyKey,
      propertyGte,
    } = c.req.valid("query");

    const searchFilter = search ? contactSearchFilter(search) : undefined;

    // Type-guarded numeric read of a jsonb property (PRD 06 / DECISIONS §3.4).
    // `contacts.properties` is untyped jsonb and `/v1/events` accepts arbitrary
    // values, so a bare `(properties->>key)::numeric` raises Postgres 22P02 —
    // and 500s the whole request — the first time ONE contact holds e.g. "n/a"
    // at the key. Only real JSON numbers count; anything else yields NULL
    // (sorted last, excluded by the ≥ filter). The key rides as a BOUND
    // PARAMETER — never interpolated — with the regex validation above as a
    // second, independent layer.
    const numericProperty = (key: string) =>
      sql`CASE WHEN jsonb_typeof(${contacts.properties} -> ${key}) = 'number' THEN (${contacts.properties} ->> ${key})::numeric END`;

    // Filter applies only when both halves are present (the schema 400s a
    // dangling propertyGte). A NULL from the guard fails the ≥ comparison, so
    // non-numeric holders are excluded rather than erroring.
    const propertyFilter =
      propertyKey !== undefined && propertyGte !== undefined
        ? sql`${numericProperty(propertyKey)} >= ${propertyGte}`
        : undefined;

    // NULLS LAST in BOTH directions so unscored (or non-numeric) contacts
    // never top the list; last_seen_at breaks ties deterministically. The
    // default path (`orderBy=lastSeenAt`, `orderDir=desc`) is byte-identical
    // to the pre-PRD-06 hardcoded ORDER BY — existing callers see no change.
    // NOTE: the GIN index on `properties` accelerates containment filters
    // only; this ORDER BY is a sequential scan — fine at GTM volume
    // (thousands of contacts), not at analytics volume.
    const orderClauses =
      orderBy === "property" && orderProperty !== undefined
        ? [
            orderDir === "asc"
              ? sql`${numericProperty(orderProperty)} asc nulls last`
              : sql`${numericProperty(orderProperty)} desc nulls last`,
            desc(contacts.lastSeenAt),
          ]
        : orderBy === "firstSeenAt"
          ? [
              orderDir === "asc"
                ? asc(contacts.firstSeenAt)
                : desc(contacts.firstSeenAt),
            ]
          : [
              orderDir === "asc"
                ? asc(contacts.lastSeenAt)
                : desc(contacts.lastSeenAt),
            ];

    // Valued events are owned the PRD 05 way: by `contact_id` when the row
    // carries one, and only otherwise by the contact's canonical event key
    // (external_id ?? anonymous_id ?? id — the same precedence `ingestEvent`
    // resolves, served by the partial user_events_valued_user_idx). The FK arm
    // is what the string arm cannot do: adoption stamps `contact_id` WITHOUT
    // rewriting the frozen `user_id`, so a person's pre-identify (or
    // merged-away) revenue sat under a key that no longer equals their
    // canonical one and this filter never counted it. The `contact_id is null`
    // guard on the string arm keeps it to rows nobody owns — an unowned row
    // whose key happens to collide with another contact's is the bug PRD 05
    // exists to close.
    // Exclusions come from lib/revenue.ts (static machinery events + funnel
    // milestone triggers + the browser trust gate): one deal's value rides
    // several rows, and pk_-minted values are forgeable.
    const revenueFilter =
      minRevenue !== undefined
        ? sql`(
            select coalesce(sum(ue.value), 0)
            from user_events ue
            where (
                ue.contact_id = ${contacts.id}
                or (ue.contact_id is null and ue.user_id = ${contactKeySql()})
              )
              and ue.value is not null
              and ue.event not in (${sql.join(
                revenueExcludedEvents().map((e) => sql`${e}`),
                sql`, `,
              )})
              and (ue.source is null or ue.source <> 'inapp')
          ) >= ${minRevenue}`
        : undefined;
    const dealStageFilter = dealStage
      ? sql`exists (
          select 1 from deals d
          where d.contact_id = ${contacts.id}
            and d.canonical_stage = ${dealStage}
        )`
      : undefined;

    // PRD 01 — one conjunct, one predicate (`identifiedContactFilter`), so
    // `identified` and `anonymous` stay exact complements. It rides the SAME
    // `where` as every other filter below, which is what keeps the page query
    // and the `count()` in lockstep.
    const identityFilter =
      identity === "identified"
        ? identifiedContactFilter()
        : identity === "anonymous"
          ? not(identifiedContactFilter())
          : undefined;

    const where = and(
      isNull(contacts.deletedAt),
      ...(identityFilter ? [identityFilter] : []),
      ...(searchFilter ? [searchFilter] : []),
      ...(revenueFilter ? [revenueFilter] : []),
      ...(dealStageFilter ? [dealStageFilter] : []),
      ...(propertyFilter ? [propertyFilter] : []),
    );

    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(contacts)
        .where(where)
        .orderBy(...orderClauses)
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

    // PRD 05 T6 — preference rows are read by ownership stamp; the old
    // `external_id ?? id` string derivation goes stale on adoption.
    const [prefRows, revenue, groupRows] = await Promise.all([
      db
        .select()
        .from(emailPreferences)
        .where(eq(emailPreferences.contactId, contact.id))
        .limit(1),
      // Valued events are keyed by the contact's canonical event key — the
      // same precedence ingestEvent resolves (`external ?? anon ?? id`).
      getContactRevenue({
        db,
        key: contact.externalId ?? contact.anonymousId ?? contact.id,
        contactId: contact.id,
      }),
      // The contact's live group memberships (mirrors the admin groups router's
      // join idiom): `group_memberships` → `groups`, live groups only, ordered
      // by group type then most-recently-joined.
      db
        .select({
          groupType: groups.groupType,
          groupKey: groups.groupKey,
          displayName: groups.displayName,
          role: groupMemberships.role,
          joinedAt: groupMemberships.joinedAt,
        })
        .from(groupMemberships)
        .innerJoin(groups, eq(groupMemberships.groupId, groups.id))
        .where(
          and(
            eq(groupMemberships.contactId, contact.id),
            isNull(groups.deletedAt),
          ),
        )
        .orderBy(asc(groups.groupType), desc(groupMemberships.joinedAt)),
    ]);

    const prefs = prefRows[0] ? serializePrefs(prefRows[0]) : null;
    const groupsList = groupRows.map((r) => ({
      groupType: r.groupType,
      groupKey: r.groupKey,
      displayName: r.displayName,
      role: r.role,
      joinedAt: r.joinedAt.toISOString(),
    }));

    return c.json(
      {
        contact: serializeContact(contact),
        preferences: prefs,
        revenue,
        groups: groupsList,
      },
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
      // PRD 06 T4 (L5 row 14): an admin create asserts identity — the body
      // carries `externalId`/`email` ONLY, so the narrow `trustedKinds` is the
      // honest statement; create-on-miss, no clamp. Enforced by T5.
      policy: {
        create: "on-miss",
        allowMerge: "any",
        trustedKinds: ["external", "email"],
      },
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
        // PRD 06 T4 (L5 row 15): an admin update re-supplies the row's OWN
        // identity keys (externalId/anonymousId/email) to ride the
        // fill-in-link path — an admin may assert any kind, so the full grant
        // is the honest statement; create-on-miss, no clamp. Enforced by T5.
        policy: {
          create: "on-miss",
          allowMerge: "any",
          trustedKinds: ALL_IDENTITY_KINDS,
        },
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
    const { db, hatchet, logger } = c.get("container");
    const { id } = c.req.valid("param");

    const contact = await resolveContact({ db, id });
    if (!contact) {
      return c.json({ error: "Contact not found" }, 404);
    }

    // Soft-delete + erasure hook in ONE transaction (PRD 02 T1): every
    // contact_aliases row keyed to the erased contact is that person's own
    // identity data, whatever `reason`/`from_contact_id` it carries.
    //
    // PRD 04 T5 (DECISIONS §15.3): this route is the ERASURE hook, so it also
    // soft-unlinks every live account link at that pair's own next version
    // (tokens hard-deleted) AND, via `erase: true`, nulls the personal display
    // fields (verified_email/username/avatar_url) on every historical row —
    // the version sequence survives erasure; the personal data does not. The
    // transaction RETURNS the unlink facts; PRD 08 binds them and emits one
    // `account.unlinked` per fact post-commit so mirrors converge.
    const linkUnlinks = await db.transaction(async (tx) => {
      const facts = await unlinkAccountsForContactInTx(tx, contact.id, {
        reason: "api",
        erase: true,
      });
      await tx
        .update(contacts)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(contacts.id, contact.id));
      await deleteIdentityAliasesForContact(tx, contact.id);
      return facts;
    });

    // PRD 08 T3 — one `account.unlinked` per soft-unlinked row, `reason:
    // "api"`, STRICTLY after the transaction resolved (a rolled-back erasure
    // never reaches this line). This route runs its own transaction rather
    // than going through `softDeleteContact`, so it owns this emit itself; the
    // shared fan-out keeps the payload and dedupe key identical to the other
    // legs.
    //
    // The CONTAINER's handles, like every other emit in this file: a
    // deployment using `overrides.hatchet` must not have this one emit slip
    // past onto the module singleton's live gRPC dial while `contact.updated`
    // from the sibling route goes to the override.
    emitAccountUnlinked(db, linkUnlinks, { hatchet, logger });

    // NO journey-plane re-ingest here, deliberately (PRD 08 T5), for the same
    // two reasons `softDeleteContact` states at its own emit: this route IS
    // the erasure hook, so writing a fresh `user_events` row for the contact
    // it just erased contradicts the erasure — and the only keys available are
    // a pin at a soft-deleted row (dropped as provenance-lost) or a value key
    // that would MINT the erased contact straight back. The customer's mirror
    // still converges via the emit above.

    return c.json({ deleted: true }, 200);
  });
