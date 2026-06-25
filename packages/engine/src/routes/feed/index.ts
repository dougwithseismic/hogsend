import { feedItems } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, count, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../../app.js";
import { ingestEvent } from "../../lib/ingestion.js";
import { getRedis } from "../../lib/redis.js";
import { errorSchema } from "../../lib/schemas.js";
import { resolveFeedRecipient } from "./recipient.js";

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

type FeedItemRow = typeof feedItems.$inferSelect;

const feedItemSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string().nullable(),
  body: z.string().nullable(),
  blocks: z.array(z.record(z.string(), z.unknown())).nullable(),
  actionUrl: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  category: z.string(),
  status: z.enum(["unseen", "seen", "read", "archived"]),
  seenAt: z.string().nullable(),
  readAt: z.string().nullable(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Deps the per-item `inapp.*` emit needs from the container. */
type IngestDeps = Pick<
  Parameters<typeof ingestEvent>[0],
  "db" | "registry" | "hatchet" | "logger" | "analytics"
>;

/**
 * Emit one server-side `inapp.*` event per updated feed item id (shared by
 * `/mark` and `/mark-all`'s per-item branch). The idempotency key matches the
 * SDK's optimistic client capture so the journey fires once.
 */
function emitMarkEvents(
  deps: IngestDeps,
  args: {
    ids: { id: string }[];
    eventType: string;
    feedId: string;
    recipientKey: string;
  },
): Promise<unknown> {
  return Promise.allSettled(
    args.ids.map((r) =>
      ingestEvent({
        ...deps,
        event: {
          event: args.eventType,
          // recipientKey IS the canonical contact key — pass it as userId so
          // the resolver lands on the SAME contact.
          userId: args.recipientKey,
          eventProperties: { feedItemId: r.id, feedId: args.feedId },
          idempotencyKey: `inapp:${args.feedId}:${r.id}:${args.eventType}`,
          source: "inapp",
        },
      }),
    ),
  );
}

function serializeFeedItem(row: FeedItemRow) {
  return {
    id: row.id,
    type: row.type,
    title: row.title ?? null,
    body: row.body ?? null,
    blocks: (row.blocks ?? null) as Record<string, unknown>[] | null,
    actionUrl: row.actionUrl ?? null,
    metadata: (row.metadata ?? null) as Record<string, unknown> | null,
    category: row.category,
    status: row.status,
    seenAt: row.seenAt?.toISOString() ?? null,
    readAt: row.readAt?.toISOString() ?? null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Mark-state model
// ---------------------------------------------------------------------------

const markState = z.enum(["seen", "read", "archived", "unseen", "unread"]);
type MarkState = z.infer<typeof markState>;

type FeedUpdateSet = Partial<{
  status: "unseen" | "seen" | "read" | "archived";
  seenAt: Date | null;
  readAt: Date | null;
  archivedAt: Date | null;
  updatedAt: Date;
}>;

/**
 * Map a requested mark `state` to (a) the row UPDATE patch and (b) the server-
 * side `inapp.*` event name. The DB enum is `[unseen, seen, read, archived]`;
 * `unread` is a virtual state meaning "seen-but-not-read" (status `seen`, clear
 * `readAt`).
 */
function markStateToUpdate(state: MarkState): {
  set: FeedUpdateSet;
  eventType: string;
} {
  const now = new Date();
  switch (state) {
    case "seen":
      return {
        set: { status: "seen", seenAt: now, updatedAt: now },
        eventType: "inapp.item_seen",
      };
    case "read":
      return {
        // `seenAt` is only set here when null is desired; we always stamp it so a
        // read implies seen.
        set: { status: "read", readAt: now, seenAt: now, updatedAt: now },
        eventType: "inapp.item_read",
      };
    case "archived":
      return {
        set: { status: "archived", archivedAt: now, updatedAt: now },
        eventType: "inapp.item_archived",
      };
    case "unseen":
      return {
        set: { status: "unseen", seenAt: null, readAt: null, updatedAt: now },
        eventType: "inapp.item_unseen",
      };
    case "unread":
      return {
        set: { status: "seen", readAt: null, updatedAt: now },
        eventType: "inapp.item_unread",
      };
  }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const listQuerySchema = z.object({
  feedId: z.string().optional(),
  status: z.enum(["unseen", "seen", "read", "archived", "all"]).optional(),
  before: z.string().optional(),
  after: z.string().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
  // Recipient resolution (server-side; never trusted as recipientKey directly).
  userToken: z.string().optional(),
  anonymousId: z.string().optional(),
  userId: z.string().optional(),
  email: z.string().optional(),
});

const listResponseSchema = z.object({
  items: z.array(feedItemSchema),
  pageInfo: z.object({
    before: z.string().nullable(),
    after: z.string().nullable(),
    hasNextPage: z.boolean(),
  }),
  metadata: z.object({
    total_count: z.number(),
    unseen_count: z.number(),
    unread_count: z.number(),
  }),
});

const markBodySchema = z.object({
  ids: z.array(z.string()).min(1),
  state: markState,
  feedId: z.string().optional(),
  userToken: z.string().optional(),
  anonymousId: z.string().optional(),
  userId: z.string().optional(),
  email: z.string().optional(),
});

const markAllBodySchema = z.object({
  state: markState,
  feedId: z.string().optional(),
  userToken: z.string().optional(),
  anonymousId: z.string().optional(),
  userId: z.string().optional(),
  email: z.string().optional(),
});

const streamQuerySchema = z.object({
  feedId: z.string().optional(),
  userToken: z.string().optional(),
  anonymousId: z.string().optional(),
  userId: z.string().optional(),
  email: z.string().optional(),
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Feed"],
  summary: "List in-app feed items for the resolved recipient",
  description:
    "Recipient-scoped server-side. A publishable key reads its own anon feed (anonymousId) or a token-verified userId; a secret key may pass userId/email directly. NEVER reads recipientKey from the request.",
  request: { query: listQuerySchema },
  responses: {
    200: {
      content: { "application/json": { schema: listResponseSchema } },
      description: "The recipient's feed page + counts",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Missing identity",
    },
    403: {
      content: { "application/json": { schema: errorSchema } },
      description: "Invalid userToken",
    },
  },
});

const markRoute = createRoute({
  method: "post",
  path: "/mark",
  tags: ["Feed"],
  summary: "Mark specific feed items",
  description:
    "Updates the given item ids INTERSECTED with the recipient's own rows (a pk_ caller can never read or mutate another recipient's items, even by guessing ids), then emits an `inapp.*` event server-side (deduped against the client's optimistic capture by a shared idempotency key).",
  request: {
    body: { content: { "application/json": { schema: markBodySchema } } },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ updated: z.number() }),
        },
      },
      description: "Items updated",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Missing identity",
    },
    403: {
      content: { "application/json": { schema: errorSchema } },
      description: "Invalid userToken",
    },
  },
});

const markAllRoute = createRoute({
  method: "post",
  path: "/mark-all",
  tags: ["Feed"],
  summary: "Mark all of the recipient's feed items",
  request: {
    body: { content: { "application/json": { schema: markAllBodySchema } } },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ updated: z.number() }),
        },
      },
      description: "Items updated",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Missing identity",
    },
    403: {
      content: { "application/json": { schema: errorSchema } },
      description: "Invalid userToken",
    },
  },
});

const streamRoute = createRoute({
  method: "get",
  path: "/stream",
  tags: ["Feed"],
  summary: "SSE stream of realtime feed events for the resolved recipient",
  description:
    "Server-Sent Events over `feed:<recipientKey>` (Redis pub/sub via a DEDICATED subscriber connection). Closes the subscriber on disconnect.",
  request: { query: streamQuerySchema },
  responses: {
    200: { description: "SSE stream" },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Missing identity",
    },
    403: {
      content: { "application/json": { schema: errorSchema } },
      description: "Invalid userToken",
    },
  },
});

// The feed router does NOT re-apply auth internally — the data-plane prefix gate
// in `routes/index.ts` (`requirePublishableOrIngest`) runs before requests reach
// here. The routes still fail-closed on identity via `resolveFeedRecipient`.
export const feedRouter = new OpenAPIHono<AppEnv>()
  .openapi(listRoute, async (c) => {
    const { db } = c.get("container");
    const q = c.req.valid("query");

    const rec = await resolveFeedRecipient(c, q);
    if (!rec.ok) return c.json({ error: rec.error }, rec.status);

    // EVERY query is scoped WHERE recipient_key = <server-derived key>.
    const where = [eq(feedItems.recipientKey, rec.recipientKey)];
    if (q.feedId) where.push(eq(feedItems.category, q.feedId));
    if (q.status && q.status !== "all") {
      where.push(eq(feedItems.status, q.status));
    }
    // Guard against an unparseable cursor: `new Date("garbage")` is `Invalid
    // Date`, which drizzle would bind as an invalid timestamp (Postgres 22007 →
    // 500). Skip the bound rather than error; the recipient scope still holds.
    if (q.before) {
      const d = new Date(q.before);
      if (!Number.isNaN(d.getTime())) where.push(lt(feedItems.createdAt, d));
    }
    if (q.after) {
      const d = new Date(q.after);
      if (!Number.isNaN(d.getTime())) where.push(gt(feedItems.createdAt, d));
    }

    // `pageSize` is already capped at 100 by the query schema (`.max(100)`).
    const pageSize = q.pageSize ?? 20;
    const rows = await db
      .select()
      .from(feedItems)
      .where(and(...where))
      .orderBy(desc(feedItems.createdAt))
      .limit(pageSize + 1);

    const hasNextPage = rows.length > pageSize;
    const page = rows.slice(0, pageSize);

    // Recipient-scoped metadata counts (independent of the page filters, except
    // the same recipient scope).
    const metaRows = await db
      .select({
        total: count(),
        unseen: count(sql`CASE WHEN ${feedItems.status} = 'unseen' THEN 1 END`),
        unread: count(
          sql`CASE WHEN ${feedItems.status} IN ('unseen', 'seen') THEN 1 END`,
        ),
      })
      .from(feedItems)
      .where(eq(feedItems.recipientKey, rec.recipientKey));
    const m = metaRows[0] ?? { total: 0, unseen: 0, unread: 0 };

    return c.json(
      {
        items: page.map(serializeFeedItem),
        pageInfo: {
          before: page.at(-1)?.createdAt.toISOString() ?? null,
          after: page[0]?.createdAt.toISOString() ?? null,
          hasNextPage,
        },
        metadata: {
          total_count: m.total,
          unseen_count: m.unseen,
          unread_count: m.unread,
        },
      },
      200,
    );
  })
  .openapi(markRoute, async (c) => {
    const { db, registry, hatchet, logger, analytics } = c.get("container");
    const body = c.req.valid("json");

    const rec = await resolveFeedRecipient(c, body);
    if (!rec.ok) return c.json({ error: rec.error }, rec.status);

    const { set, eventType } = markStateToUpdate(body.state);
    const feedId = body.feedId ?? "in_app";

    // INTERSECT the requested ids with the recipient's OWN rows — fail-closed
    // scoping. `recipientKey` is server-derived, NOT from the body, so a pk_
    // caller can never mutate another recipient's items even by guessing ids.
    const updated = await db
      .update(feedItems)
      .set(set)
      .where(
        and(
          eq(feedItems.recipientKey, rec.recipientKey),
          inArray(feedItems.id, body.ids),
        ),
      )
      .returning({ id: feedItems.id });

    // Emit `inapp.*` server-side per updated id. Shared idempotency key dedups
    // against the SDK's optimistic client capture (whichever lands second is
    // absorbed by `user_events.idempotencyKey`), so the journey fires once.
    await emitMarkEvents(
      { db, registry, hatchet, logger, analytics },
      { ids: updated, eventType, feedId, recipientKey: rec.recipientKey },
    );

    return c.json({ updated: updated.length }, 200);
  })
  .openapi(markAllRoute, async (c) => {
    const { db, registry, hatchet, logger, analytics } = c.get("container");
    const body = c.req.valid("json");

    const rec = await resolveFeedRecipient(c, body);
    if (!rec.ok) return c.json({ error: rec.error }, rec.status);

    const { set, eventType } = markStateToUpdate(body.state);
    const feedId = body.feedId ?? "in_app";

    const where = [eq(feedItems.recipientKey, rec.recipientKey)];
    if (body.feedId) where.push(eq(feedItems.category, body.feedId));

    const updated = await db
      .update(feedItems)
      .set(set)
      .where(and(...where))
      .returning({ id: feedItems.id });

    // Mark-all-read emits a single `inapp.feed_cleared` (not per-item); other
    // states emit per-item `inapp.*`, sharing the dedup key with the client.
    if (body.state === "read") {
      await ingestEvent({
        db,
        registry,
        hatchet,
        logger,
        analytics,
        event: {
          event: "inapp.feed_cleared",
          userId: rec.recipientKey,
          eventProperties: { feedId },
          idempotencyKey: `inapp:${feedId}:all:inapp.feed_cleared`,
          source: "inapp",
        },
      }).catch(() => {});
    } else {
      await emitMarkEvents(
        { db, registry, hatchet, logger, analytics },
        { ids: updated, eventType, feedId, recipientKey: rec.recipientKey },
      );
    }

    return c.json({ updated: updated.length }, 200);
  })
  .openapi(streamRoute, async (c) => {
    const rec = await resolveFeedRecipient(c, c.req.valid("query"));
    if (!rec.ok) return c.json({ error: rec.error }, rec.status);
    const channel = `feed:${rec.recipientKey}`;

    return streamSSE(c, async (stream) => {
      // DEDICATED subscriber connection — NEVER `.subscribe()` on the shared
      // getRedis() singleton (it would poison the rate-limiter/auth/cache).
      const sub = getRedis().duplicate();
      let closed = false;
      const teardown = async () => {
        if (closed) return;
        closed = true;
        try {
          await sub.unsubscribe(channel);
        } catch {
          // best-effort
        }
        // Close the duplicate; no leak.
        sub.disconnect();
      };
      stream.onAbort(() => {
        void teardown();
      });

      sub.on("message", (_ch, msg) => {
        // writeSSE rejects after close — swallow.
        void stream.writeSSE({ event: "feed", data: msg }).catch(() => {});
      });

      try {
        await sub.subscribe(channel);
        await stream.writeSSE({ event: "ready", data: "{}" });
        // Keep-alive heartbeat until aborted.
        while (!stream.aborted && !closed) {
          await stream.sleep(25_000);
          if (stream.aborted || closed) break;
          await stream.writeSSE({ event: "ping", data: "{}" }).catch(() => {});
        }
      } finally {
        await teardown();
      }
    });
  });
