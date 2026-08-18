import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import {
  ALL_IDENTITY_KINDS,
  findContacts,
  PublishableAnonymousMergeError,
  projectPublicContact,
  resolveContact,
  resolveOrCreateContact,
  serializeContact,
  softDeleteContact,
} from "../../lib/contacts.js";
import { emitOutbound } from "../../lib/outbound.js";
import { applyListMembership } from "../../lib/preferences.js";
import { errorSchema } from "../../lib/schemas.js";
import {
  gatePublishableIdentity,
  listMembershipError,
  requireIdentity,
} from "../_shared.js";
import { resolveFeedRecipient } from "../feed/recipient.js";

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
            // key, normally an EXTRA alongside email/userId rather than an
            // identity arm of its own.
            //
            // NOT a guarantee, on the publishable path. The handler gates with
            // `gatePublishableIdentity`, NOT `requireIdentity`, and that gate
            // returns early for a pk_ caller who claims nothing
            // (`routes/_shared.ts` — "No claimed identity → anon-only,
            // allowed"). The create arm of `resolveContactShared` carries no
            // `restrictToAnonymous` guard either — that flag bites only
            // fill-in-link and collide-merge. So a hand-rolled `pk_` fetch
            // sending ONLY `anonymousId` still MINTS an anonymous-only contact.
            //
            // Known and deliberately deferred (ghost-contacts BACKLOG): refusing
            // here would force `id: z.string().nullable()` on the published
            // response schema plus a `@hogsend/client` type widening. No
            // first-party SDK emits that shape — `@hogsend/js` `identify()`
            // always sends a `userId` — so the residual is a hand-rolled
            // request, not an SDK path. Do not "fix" this comment back into a
            // guarantee the code does not provide.
            anonymousId: z.string().min(1).max(200).optional(),
            properties: z.record(z.string(), z.unknown()).optional(),
            lists: z.record(z.string(), z.boolean()).optional(),
            // Publishable-key identity assertion (§Phase 1). Ignored on the
            // secret-key path.
            userToken: z.string().optional(),
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
    403: {
      content: { "application/json": { schema: errorSchema } },
      description:
        "Publishable key attempted to act on another identity without a verified userToken",
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

// ---------------------------------------------------------------------------
// GET /v1/contacts/me — the BROWSER read of the identified contact's traits
// (publishable OR secret-ingest tier; guarded as a LITERAL in routes/index.ts).
// Identity is recipient-scoped SERVER-SIDE via `resolveFeedRecipient`, the same
// leak boundary as `GET /v1/flags` and the in-app feed: a userToken-verified
// userId, a secret key's trusted userId/email, or a publishable caller's OWN
// anon id (a pk_ `anonymousId` colliding with an IDENTIFIED contact's canonical
// key is rejected 403). A request-supplied contact key is NEVER honored.
//
// What comes back is an operator ALLOWLIST projection, not the contact row: only
// exact `contacts.publicProperties` keys, plus `email` when `exposeEmail`. The
// default config is empty, so a deploy that configures nothing exposes nothing.
// No contact / empty allowlist answers 200 `{ identified: false, traits: {} }` —
// never 404, so the response does not confirm whether a contact exists.
// ---------------------------------------------------------------------------
const meQuerySchema = z.object({
  userToken: z.string().optional(),
  anonymousId: z.string().optional(),
  userId: z.string().optional(),
  email: z.string().optional(),
});

const publicContactSchema = z.object({
  identified: z.boolean(),
  traits: z.record(z.string(), z.unknown()),
  email: z.string().nullable().optional(),
});

const meRoute = createRoute({
  method: "get",
  path: "/me",
  tags: ["Contacts"],
  summary: "Read the resolved recipient's public traits",
  description:
    "Recipient-scoped server-side. Returns only the operator-allowlisted contact properties (client option `contacts.publicProperties`), plus the email when `contacts.exposeEmail` is on. Empty allowlist or no contact returns an empty projection, never 404.",
  request: { query: meQuerySchema },
  responses: {
    200: {
      content: { "application/json": { schema: publicContactSchema } },
      description: "The recipient's allowlisted traits",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Missing identity",
    },
    403: {
      content: { "application/json": { schema: errorSchema } },
      description: "Invalid userToken or non-addressable anonymousId",
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
    const { db, hatchet, logger, env } = c.get("container");
    const body = c.req.valid("json");

    const guard = gatePublishableIdentity(c, body, env.BETTER_AUTH_SECRET);
    if (guard) return guard;

    let resolved: Awaited<ReturnType<typeof resolveOrCreateContact>>;
    try {
      resolved = await resolveOrCreateContact({
        db,
        userId: body.userId,
        email: body.email,
        // §4: 2nd-precedence resolver key (zero-merge stitch).
        anonymousId: body.anonymousId,
        contactProperties: body.properties,
        // PRD 06 T3 (L5 rows 4-5): trust is DECLARED by this caller, not
        // re-inferred inside the resolver.
        //  - `create` — an upsert is an identity assertion, never observation:
        //    this route NEVER refuses to create, on either arm.
        //  - `allowMerge` — §Phase 1 GAP-1: a publishable (pk_) browser upsert
        //    is anon-clamped — its browser-readable `anonymousId` may NOT
        //    attach to / merge / poison an already-identified victim contact.
        //    Kept "anonymous-only" even when a verified token proves a
        //    `userId`: the clamp is inert there by DERIVATION (a non-anon key
        //    is present), never by hard-coding "any". Secret-key upserts are
        //    never clamped.
        //  - `trustedKinds` — from the gate's own evidence: a publishable
        //    `userId` reaching this call is token-proven
        //    (`gatePublishableIdentity` 403'd every other identity-claiming
        //    shape), so pk_ = `anonymous` (+`external` with that proof);
        //    secret = all four. Declared now, enforced by T5.
        policy:
          c.get("publishable") === true
            ? {
                create: "on-miss",
                allowMerge: "anonymous-only",
                trustedKinds: body.userId
                  ? ["anonymous", "external"]
                  : ["anonymous"],
              }
            : {
                create: "on-miss",
                allowMerge: "any",
                trustedKinds: ALL_IDENTITY_KINDS,
              },
      });
    } catch (err) {
      if (err instanceof PublishableAnonymousMergeError) {
        return c.json({ error: err.message }, 403);
      }
      throw err;
    }
    const { id, created, linked, merged } = resolved;

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
  .openapi(meRoute, async (c) => {
    const { db, contactsConfig } = c.get("container");
    const query = c.req.valid("query");
    const rec = await resolveFeedRecipient(c, query);
    if (!rec.ok) return c.json({ error: rec.error }, rec.status);
    // `resolveFeedRecipient` already did the trust work; the only remaining
    // read is the row it pinned. No `contactId` means no contact exists for
    // this recipient yet, which projects to the same empty answer as a
    // configured-closed allowlist.
    const row = rec.contactId
      ? await resolveContact({ db, id: rec.contactId })
      : null;
    // pk_ is ANON-ONLY; identity is a server-minted userToken. On the token-less
    // publishable arm the resolver pins whatever live row holds this browser's
    // anon id in its `anonymous_id` COLUMN — and that row may be an IDENTIFIED
    // contact (a server-side stitch, or a pre-logout id that leaked), because
    // `collidesWithIdentified` only rejects a value that IS a canonical key.
    // Flags tolerate that (booleans); traits are PII, so an identified row is
    // only readable through a token (or a secret key). Project it as empty.
    const tokenless = c.get("publishable") === true && !query.userToken;
    const identifiedRow = Boolean(row && (row.externalId || row.email));
    const visible = tokenless && identifiedRow ? null : row;
    return c.json(projectPublicContact(visible, contactsConfig), 200);
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

    // NOT an `account.unlinked` emit point, though `result.linkUnlinks` is
    // right there: `softDeleteContact` already fanned those out post-commit
    // (PRD 08 T3), once for all three of its callers. Emitting again here
    // would be silently swallowed by the `(endpointId, dedupeKey)` index, so
    // the duplicate would cost a build cycle and hide which layer owns the
    // fact rather than failing a test. The field stays on the result as the
    // route's reporting channel.
    //
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
