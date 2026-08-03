import { emailPreferences } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq, sql } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { resolveContact, serializePrefs } from "../../lib/contacts.js";
import {
  isUniqueViolationOn,
  UQ_CONTACT_EMAIL_PREFERENCES,
} from "../../lib/unique-violation.js";

const preferencesResponseSchema = z.object({
  id: z.string(),
  userId: z.string(),
  email: z.string(),
  unsubscribedAll: z.boolean(),
  suppressed: z.boolean(),
  bounceCount: z.number(),
  categories: z.record(z.string(), z.boolean()),
  suppressedAt: z.string().nullable(),
  lastBounceAt: z.string().nullable(),
});

const getPrefsRoute = createRoute({
  method: "get",
  path: "/{contactId}/preferences",
  tags: ["Admin"],
  summary: "Get email preferences for a contact",
  request: {
    params: z.object({ contactId: z.string() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ preferences: preferencesResponseSchema }),
        },
      },
      description: "Email preferences",
    },
    404: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Contact or preferences not found",
    },
  },
});

const updatePrefsRoute = createRoute({
  method: "put",
  path: "/{contactId}/preferences",
  tags: ["Admin"],
  summary: "Update email preferences for a contact",
  request: {
    params: z.object({ contactId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            unsubscribedAll: z.boolean().optional(),
            suppressed: z.boolean().optional(),
            categories: z.record(z.string(), z.boolean()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ preferences: preferencesResponseSchema }),
        },
      },
      description: "Preferences updated",
    },
    400: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Bad request",
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

export const preferencesRouter = new OpenAPIHono<AppEnv>()
  .openapi(getPrefsRoute, async (c) => {
    const { db } = c.get("container");
    const { contactId } = c.req.valid("param");

    const contact = await resolveContact({ db, id: contactId });
    if (!contact) {
      return c.json({ error: "Contact not found" }, 404);
    }

    // PRD 05 T6 — the contact is in hand: read by ownership stamp, never by
    // the mutable string key (which goes stale on adoption).
    const rows = await db
      .select()
      .from(emailPreferences)
      .where(eq(emailPreferences.contactId, contact.id))
      .limit(1);

    if (rows.length === 0) {
      return c.json({ error: "No preferences found for this contact" }, 404);
    }

    const prefs = rows[0] as typeof emailPreferences.$inferSelect;
    return c.json({ preferences: serializePrefs(prefs) }, 200);
  })
  .openapi(updatePrefsRoute, async (c) => {
    const { db } = c.get("container");
    const { contactId } = c.req.valid("param");
    const body = c.req.valid("json");

    const contact = await resolveContact({ db, id: contactId });
    if (!contact) {
      return c.json({ error: "Contact not found" }, 404);
    }

    if (!contact.email) {
      return c.json({ error: "Contact has no email address" }, 400);
    }
    // Bound once: the narrowing from the guard above does not survive into the
    // `upsertOnStringKey` closure below.
    const email = contact.email;

    const setClause = {
      // Fill-if-known, never null-out — the same conflict arm
      // `upsertEmailPreference` uses, so the two writers to this table
      // cannot disagree about whether a stamp may be erased.
      contactId: sql`coalesce(excluded.contact_id, ${emailPreferences.contactId})`,
      ...(body.unsubscribedAll !== undefined
        ? { unsubscribedAll: body.unsubscribedAll }
        : {}),
      ...(body.suppressed !== undefined
        ? {
            suppressed: body.suppressed,
            suppressedAt: body.suppressed ? new Date() : null,
            // Un-suppressing clears the bounce slate. `bounceCount` only
            // drives the auto-suppress threshold (the send-gate keys off
            // `suppressed`/`unsubscribedAll`), so a leftover count would
            // otherwise keep a bounced recipient pinned to the suppression
            // list with no way to remove them.
            ...(body.suppressed ? {} : { bounceCount: 0, lastBounceAt: null }),
          }
        : {}),
      ...(body.categories !== undefined ? { categories: body.categories } : {}),
      updatedAt: new Date(),
    };

    const upsertOnStringKey = () =>
      db
        .insert(emailPreferences)
        .values({
          userId: contact.externalId ?? contact.id,
          email,
          // PRD 04 dual-write: this handler resolved the contact one statement
          // ago, so the owning id is in hand — zero queries, no D6 wrapper
          // needed (there is no new call that could throw).
          contactId: contact.id,
          unsubscribedAll: body.unsubscribedAll ?? false,
          suppressed: body.suppressed ?? false,
          categories: body.categories ?? {},
        })
        .onConflictDoUpdate({
          target: [emailPreferences.userId, emailPreferences.email],
          set: setClause,
        })
        .returning();

    let upserted: typeof emailPreferences.$inferSelect | undefined;
    try {
      [upserted] = await upsertOnStringKey();
    } catch (err) {
      // PRD 05 T3 — the twin of the conversion in `upsertEmailPreference`; see
      // its comment for why the arbiter stays on the string key. This route
      // reaches the same row from the OTHER side (it keys the insert off
      // `external_id ?? id` while an adopted row may still carry the old anon
      // string), so it needs the same fallback or an admin preference edit
      // would 500 on exactly the contacts adoption has touched.
      if (!isUniqueViolationOn(err, UQ_CONTACT_EMAIL_PREFERENCES)) throw err;
      const { contactId: _excludedCoalesce, ...contactScopedSet } = setClause;
      [upserted] = await db
        .update(emailPreferences)
        .set(contactScopedSet)
        .where(
          and(
            eq(emailPreferences.contactId, contact.id),
            eq(emailPreferences.email, email),
          ),
        )
        .returning();
      // The conflicting row vanished between the INSERT and the UPDATE (a
      // concurrent merge folded it away): zero rows back, `upserted` undefined,
      // and the throw below would turn an ordinary race into a 500 the old
      // single-statement path could not produce. The row is gone, so the
      // arbiter INSERT now lands — retry it ONCE. See the twin in
      // `lib/preferences.ts`.
      if (!upserted) [upserted] = await upsertOnStringKey();
    }

    if (!upserted) {
      throw new Error("Failed to upsert preferences");
    }

    return c.json({ preferences: serializePrefs(upserted) }, 200);
  });
