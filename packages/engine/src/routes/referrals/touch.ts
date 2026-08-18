import { DEFAULT_REFERRAL_ID } from "@hogsend/core";
import type { Database } from "@hogsend/db";
import { links } from "@hogsend/db";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { touchReferral } from "../../lib/referral-intent.js";
import { recordTouch } from "../../lib/referrals.js";
import { errorSchema } from "../../lib/schemas.js";
import { resolveNamedContactId, resolveReferralId } from "./shared.js";

/**
 * `POST /v1/referrals/touch` and `POST /v1/referrals/import` (PRD 05 §7.2).
 *
 * The two routes look alike and are deliberately NOT the same call:
 *
 * - `/touch` goes through `touchReferral` (the INTENT layer), so a fresh edge
 *   emits `referral.touched` / `referral.bound` on both planes and a reward
 *   journey fires. That is what an invite, a typed code or an operator
 *   correction IS.
 * - `/import` goes through `recordTouch` (the STORE), which never emits. An
 *   import is SILENT HISTORY, exactly like `POST /v1/accounts/import`: back-
 *   filling a year of a competitor's referral ledger must not send a year of
 *   reward emails. It is also insert-only - an existing edge is reported as
 *   `existing`, never rewritten.
 */

const MAX_IMPORT_ROWS = 1000;

const sourceSchema = z.enum(["slug_entry", "invite", "manual"]);

const touchRoute = createRoute({
  method: "post",
  path: "/touch",
  tags: ["Referrals"],
  summary: "Record a referral touch",
  description:
    "Secret key + the `referrals` scope. Names the referrer by `referrerContactId`, `referrerKey` or the `slug` of their shared link (which also selects the referral). A `refereeContactId`/`refereeKey` that resolves to a contact BINDS the edge immediately; a bare `refereeKey` records the cold edge under that key. Emits `referral.touched` (and `referral.bound`) on a fresh write only.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              referral: z.string().min(1).optional(),
              referrerContactId: z.string().min(1).optional(),
              referrerKey: z.string().min(1).optional(),
              slug: z.string().min(1).optional(),
              refereeContactId: z.string().min(1).optional(),
              refereeKey: z.string().min(1).optional(),
              source: sourceSchema,
              properties: z.record(z.string(), z.unknown()).optional(),
              idempotencyKey: z.string().min(1).optional(),
            })
            .refine(
              (b) => Boolean(b.referrerContactId ?? b.referrerKey ?? b.slug),
              {
                message:
                  "one of referrerContactId, referrerKey or slug is required",
              },
            )
            .refine((b) => Boolean(b.refereeContactId ?? b.refereeKey), {
              message: "one of refereeContactId or refereeKey is required",
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
            touchId: z.string().nullable(),
            referral: z.string(),
            referrerContactId: z.string(),
            refereeContactId: z.string().nullable(),
            status: z.string(),
            created: z.boolean(),
            rejected: z.boolean(),
          }),
        },
      },
      description: "The touch (fresh or recovered)",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "No such referrer, slug or referral",
    },
  },
});

const importRoute = createRoute({
  method: "post",
  path: "/import",
  tags: ["Referrals"],
  summary: "Import historical referral touches",
  description:
    'Secret key + the `referrals` scope. INSERT-ONLY and SILENT: every row is written with `source: "import"` at its own `touchedAt`, and NOTHING is emitted - no `referral.touched`, no `referral.bound`, no journey. A row carrying a referee that resolves to a contact is written already `bound` (the self-referral check still applies). An existing edge is counted as `existing` and left untouched.',
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            referral: z.string().min(1).optional(),
            touches: z
              .array(
                z.object({
                  referrerContactId: z.string().min(1).optional(),
                  referrerKey: z.string().min(1).optional(),
                  refereeContactId: z.string().min(1).optional(),
                  refereeKey: z.string().min(1).optional(),
                  touchedAt: z.string(),
                  properties: z.record(z.string(), z.unknown()).optional(),
                  idempotencyKey: z.string().min(1).optional(),
                }),
              )
              .min(1)
              .max(MAX_IMPORT_ROWS),
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
            referral: z.string(),
            inserted: z.number(),
            existing: z.number(),
            rejected: z.number(),
            skipped: z.number(),
          }),
        },
      },
      description: "Per-row outcome counts",
    },
  },
});

/** The live `shared` link behind a slug: its owner AND its referral. */
async function resolveSlug(
  db: Database,
  slug: string,
): Promise<{
  referralId: string;
  ownerContactId: string;
  linkId: string;
} | null> {
  const [row] = await db
    .select({
      id: links.id,
      referralId: links.referralId,
      ownerContactId: links.ownerContactId,
    })
    .from(links)
    .where(and(eq(links.slug, slug.toLowerCase()), isNull(links.archivedAt)))
    .limit(1);
  if (!row?.ownerContactId) return null;
  return {
    referralId: row.referralId ?? DEFAULT_REFERRAL_ID,
    ownerContactId: row.ownerContactId,
    linkId: row.id,
  };
}

export function registerReferralTouchRoute(router: OpenAPIHono<AppEnv>) {
  router.openapi(touchRoute, async (c) => {
    const container = c.get("container");
    const { db, referrals } = container;
    const body = c.req.valid("json");

    let referralId = resolveReferralId(body.referral);
    let referrerContactId: string | null = null;
    let linkId: string | null = null;

    if (body.slug) {
      const link = await resolveSlug(db, body.slug);
      if (!link) {
        return c.json(
          { error: `no shared link with slug "${body.slug}"` },
          404,
        );
      }
      // The slug carries BOTH ends of the selection: an explicit `referral`
      // that disagrees with the link's own would credit the wrong program, so
      // the link always wins and the body's value is ignored.
      referralId = link.referralId;
      referrerContactId = link.ownerContactId;
      linkId = link.linkId;
    } else {
      referrerContactId = await resolveNamedContactId(
        db,
        body.referrerContactId ?? body.referrerKey,
      );
      if (!referrerContactId) {
        return c.json({ error: "no such referrer" }, 404);
      }
    }

    const referral = referrals.get(referralId);
    if (!referral) {
      return c.json(
        { error: `no referral "${referralId}" is registered` },
        404,
      );
    }

    const refereeContactId = await resolveNamedContactId(
      db,
      body.refereeContactId ?? body.refereeKey,
    );
    // The referee KEY is what `adoptOrphanHistory` scans for later, so a cold
    // touch must keep the caller's raw key verbatim.
    const refereeKey = body.refereeKey ?? refereeContactId ?? "";
    if (!refereeKey) {
      return c.json({ error: "no such referee" }, 404);
    }

    const result = await touchReferral({
      db,
      hatchet: container.hatchet,
      registry: container.registry,
      logger: container.logger,
      ...(container.analytics ? { analytics: container.analytics } : {}),
      referrals,
      referral,
      referrerContactId,
      refereeKey,
      refereeContactId,
      linkId,
      source: body.source,
      ...(body.properties ? { properties: body.properties } : {}),
      ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
    });

    return c.json(
      {
        touchId: result.touch?.id ?? null,
        referral: referralId,
        referrerContactId,
        refereeContactId: result.touch?.refereeContactId ?? null,
        status: result.touch?.status ?? "skipped",
        created: result.created,
        rejected: result.rejected,
      },
      200,
    );
  });
}

export function registerReferralImportRoute(router: OpenAPIHono<AppEnv>) {
  router.openapi(importRoute, async (c) => {
    const { db, referrals } = c.get("container");
    const body = c.req.valid("json");
    const referralId = resolveReferralId(body.referral);
    // The definition is OPTIONAL here: importing history into a program whose
    // code was deleted is legitimate, and `recordTouch` only needs it for
    // `beforeTouch` (which an import deliberately does not run through the
    // intent layer anyway).
    const referral = referrals.get(referralId);

    let inserted = 0;
    let existing = 0;
    let rejected = 0;
    let skipped = 0;

    for (const row of body.touches) {
      const touchedAt = new Date(row.touchedAt);
      const referrerContactId = await resolveNamedContactId(
        db,
        row.referrerContactId ?? row.referrerKey,
      );
      if (!referrerContactId || Number.isNaN(touchedAt.getTime())) {
        skipped++;
        continue;
      }
      const refereeContactId = await resolveNamedContactId(
        db,
        row.refereeContactId ?? row.refereeKey,
      );
      const refereeKey = row.refereeKey ?? refereeContactId;
      if (!refereeKey) {
        skipped++;
        continue;
      }

      const result = await recordTouch({
        db,
        referralId,
        ...(referral ? { referral } : {}),
        referrerContactId,
        refereeKey,
        refereeContactId,
        source: "import",
        touchedAt,
        ...(row.properties ? { properties: row.properties } : {}),
        ...(row.idempotencyKey ? { idempotencyKey: row.idempotencyKey } : {}),
      });

      if (result.rejected) rejected++;
      else if (result.created) inserted++;
      else existing++;
    }

    return c.json(
      { referral: referralId, inserted, existing, rejected, skipped },
      200,
    );
  });
}
