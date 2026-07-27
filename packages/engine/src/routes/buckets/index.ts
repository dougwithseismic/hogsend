import { bucketMemberships } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import {
  addBucketMember,
  BucketMembershipError,
  removeBucketMember,
} from "../../buckets/membership.js";
import { errorSchema } from "../../lib/schemas.js";

/**
 * The secret-key membership data plane for `kind:"manual"` buckets (PRD 01
 * T01.4).
 *
 * This router adds NO membership logic of its own — every mutation delegates to
 * T01.3's `addBucketMember` / `removeBucketMember`, which own the
 * `bucket_memberships` write, the epoch, the `entryLimit` gate, the `minDwell`
 * deferral and the `emitBucketTransition` call. The route's only jobs are
 * validation, mapping the service's refusal codes onto HTTP statuses, and the
 * read.
 *
 * It does NOT re-apply auth internally: the data-plane prefix guards in
 * `routes/index.ts` apply `requireApiKey` + `requireScope("ingest")` to
 * `/v1/buckets` (bare + `/*`) before a request reaches here, exactly as they do
 * for `/v1/groups`. Membership is operator data — a publishable (pk_) browser
 * key must NEVER mutate it (AC 9).
 */

// Mirrors `BucketMembershipVerdict` exactly — `leave-seeded` (a suppressed
// LEAVE) is distinct from `seeded` (a suppressed JOIN) so a caller can tell
// them apart from the response alone.
const verdictSchema = z.enum([
  "applied",
  "already-active",
  "already-left",
  "deferred",
  "suppressed-by-entry-limit",
  "seeded",
  "leave-seeded",
]);

// The committed `{ emitted, epoch, verdict }` contract (AC 10), passed through
// verbatim so a caller can act on the outcome without re-querying.
const mutationResultSchema = z.object({
  emitted: z.boolean(),
  epoch: z.number(),
  verdict: verdictSchema,
});

const memberSchema = z.object({
  id: z.string(),
  userId: z.string(),
  userEmail: z.string().nullable(),
  bucketId: z.string(),
  status: z.string(),
  enteredAt: z.string(),
  leftAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  maxDwellAt: z.string().nullable(),
  entryCount: z.number(),
  source: z.string().nullable(),
  context: z.record(z.string(), z.unknown()),
});

function serializeMember(row: typeof bucketMemberships.$inferSelect) {
  return {
    id: row.id,
    userId: row.userId,
    userEmail: row.userEmail,
    bucketId: row.bucketId,
    status: row.status,
    enteredAt: row.enteredAt.toISOString(),
    leftAt: row.leftAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    maxDwellAt: row.maxDwellAt?.toISOString() ?? null,
    entryCount: row.entryCount,
    source: row.source,
    context: (row.context ?? {}) as Record<string, unknown>,
  };
}

/**
 * Map the service's refusal onto a status:
 *  - `bucket_not_found`  → 404, the bucket is not in the registry at all.
 *  - `bucket_not_manual` → 409, the bucket exists but its membership is owned
 *    by its criteria; an explicit write would be silently reverted by the next
 *    evaluation, so it fails loudly instead of pretending to succeed.
 *
 * Anything else rethrows to the app error handler — a service bug must not be
 * laundered into a 4xx.
 */
function membershipErrorStatus(err: unknown): 404 | 409 | null {
  if (!(err instanceof BucketMembershipError)) return null;
  return err.code === "bucket_not_found" ? 404 : 409;
}

const bucketIdParam = z.object({ id: z.string().min(1) });

const addMemberRoute = createRoute({
  method: "post",
  path: "/{id}/members",
  tags: ["Buckets"],
  summary: "Add a member to a manual bucket",
  description:
    'Writes the active `bucket_memberships` row and emits `bucket:entered:<id>` subject to the bucket\'s `entryLimit`. Idempotent: re-adding an active member returns `already-active` and emits nothing. Pass `emit: false` to materialize an existing population WITHOUT firing transitions into live journeys (verdict `seeded`). Only `kind:"manual"` buckets accept an explicit write.',
  request: {
    params: bucketIdParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            userId: z.string().min(1),
            /** Denormalized onto the row; resolved from the contact when omitted. */
            userEmail: z.string().nullable().optional(),
            /**
             * Provenance pin for the emitted transition; resolved from the live
             * contact when omitted. Bound to a `uuid` contacts column, so a
             * malformed id is a 400 here rather than a 22P02 500 downstream.
             */
            contactId: z.string().uuid().optional(),
            source: z.string().min(1).optional(),
            context: z.record(z.string(), z.unknown()).optional(),
            emit: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: mutationResultSchema } },
      description: "Membership mutation outcome",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Unknown bucket",
    },
    409: {
      content: { "application/json": { schema: errorSchema } },
      description: 'Bucket is not kind:"manual"',
    },
  },
});

const removeMemberRoute = createRoute({
  method: "delete",
  path: "/{id}/members/{userId}",
  tags: ["Buckets"],
  summary: "Remove a member from a manual bucket",
  description:
    'Transitions the active row to `left` and emits `bucket:left:<id>` with `reason: "manual"`. A leave inside the bucket\'s `minDwell` window is DEFERRED (verdict `deferred`), never dropped — the reconcile cron resolves it. Removing a non-member returns `already-left` and emits nothing.',
  request: {
    params: bucketIdParam.extend({ userId: z.string().min(1) }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: mutationResultSchema } },
      description: "Membership mutation outcome",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Unknown bucket",
    },
    409: {
      content: { "application/json": { schema: errorSchema } },
      description: 'Bucket is not kind:"manual"',
    },
  },
});

const listMembersRoute = createRoute({
  method: "get",
  path: "/{id}/members",
  tags: ["Buckets"],
  summary: "List a bucket's members",
  description:
    "Newest-entered first. Read-only, so it serves dynamic buckets too — only mutation is restricted to manual buckets.",
  request: {
    params: bucketIdParam,
    query: z.object({
      limit: z.coerce.number().min(1).max(100).default(50),
      offset: z.coerce.number().min(0).default(0),
      status: z.enum(["active", "left"]).default("active"),
      userId: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            members: z.array(memberSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
      description: "Paginated bucket members",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Unknown bucket",
    },
  },
});

export const bucketsRouter = new OpenAPIHono<AppEnv>()
  .openapi(addMemberRoute, async (c) => {
    const { db, registry, hatchet, logger, bucketRegistry } =
      c.get("container");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    try {
      const result = await addBucketMember({
        db,
        registry,
        hatchet,
        logger,
        bucketRegistry,
        bucketId: id,
        userId: body.userId,
        userEmail: body.userEmail,
        contactId: body.contactId,
        source: body.source,
        context: body.context,
        emit: body.emit,
      });
      return c.json(result, 200);
    } catch (err) {
      const status = membershipErrorStatus(err);
      if (status === null) throw err;
      return c.json({ error: (err as Error).message }, status);
    }
  })
  .openapi(removeMemberRoute, async (c) => {
    const { db, registry, hatchet, logger, bucketRegistry } =
      c.get("container");
    const { id, userId } = c.req.valid("param");

    try {
      const result = await removeBucketMember({
        db,
        registry,
        hatchet,
        logger,
        bucketRegistry,
        bucketId: id,
        userId,
      });
      return c.json(result, 200);
    } catch (err) {
      const status = membershipErrorStatus(err);
      if (status === null) throw err;
      return c.json({ error: (err as Error).message }, status);
    }
  })
  .openapi(listMembersRoute, async (c) => {
    const { db, bucketRegistry } = c.get("container");
    const { id } = c.req.valid("param");
    const { limit, offset, status, userId } = c.req.valid("query");

    if (!bucketRegistry.has(id)) {
      return c.json({ error: `Unknown bucket: ${id}` }, 404);
    }

    const conditions = [
      eq(bucketMemberships.bucketId, id),
      eq(bucketMemberships.status, status),
      isNull(bucketMemberships.deletedAt),
    ];
    if (userId) conditions.push(eq(bucketMemberships.userId, userId));
    const where = and(...conditions);

    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(bucketMemberships)
        .where(where)
        // `enteredAt` alone is not a total order (a bulk seed stamps one
        // instant across the whole chunk), so tie-break on `id` to keep the
        // page boundary stable across calls.
        .orderBy(desc(bucketMemberships.enteredAt), desc(bucketMemberships.id))
        .limit(limit)
        .offset(offset),
      db.select({ count: count() }).from(bucketMemberships).where(where),
    ]);

    return c.json(
      {
        members: rows.map(serializeMember),
        total: totalRows[0]?.count ?? 0,
        limit,
        offset,
      },
      200,
    );
  });
