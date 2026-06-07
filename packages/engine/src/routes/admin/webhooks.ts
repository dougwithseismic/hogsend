import { randomUUID } from "node:crypto";
import { webhookDeliveries, webhookEndpoints } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { count, desc, eq } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { errorSchema } from "../../lib/schemas.js";
import {
  generateWebhookSecret,
  WEBHOOK_EVENT_TYPES,
  type WebhookEventType,
} from "../../lib/webhook-signing.js";
import { deliverWebhookTask } from "../../workflows/deliver-webhook.js";

/**
 * Admin outbound-webhook management (Section 1.8). Mounted at
 * `/v1/admin/webhooks`, it inherits `requireAdmin` + `rateLimit` +
 * `auditMiddleware` from the admin router root — no per-route auth here.
 *
 * Secret-once invariant (LOCKED decision 1): the full `whsec_…` secret is
 * returned ONLY on create + rotate-secret. `serializeEndpoint` NEVER includes
 * it; list/get/patch expose `secretPrefix` only. Anything that returns the full
 * secret is an explicit, audited create/rotate response.
 */

// The catalog enum for request validation — derived from the SINGLE source of
// truth in `webhook-signing.ts` (Section 1.3). `z.enum` needs a non-empty tuple,
// which `WEBHOOK_EVENT_TYPES` (12 strings, `as const`) satisfies.
const eventTypeEnum = z.enum(
  WEBHOOK_EVENT_TYPES as unknown as [WebhookEventType, ...WebhookEventType[]],
);

const webhookEndpointSchema = z.object({
  id: z.string(),
  url: z.string(),
  description: z.string().nullable(),
  eventTypes: z.array(z.string()),
  secretPrefix: z.string(),
  status: z.enum(["enabled", "disabled"]),
  organizationId: z.string().nullable(),
  lastDeliveryAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Webhooks"],
  summary: "List outbound webhook endpoints",
  request: {
    query: z.object({
      limit: z.coerce.number().min(1).max(100).default(50),
      offset: z.coerce.number().min(0).default(0),
      includeDisabled: z.enum(["true", "false"]).default("true"),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            endpoints: z.array(webhookEndpointSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
      description: "Paginated webhook endpoint list (secret never included)",
    },
  },
});

const createEndpointRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Admin — Webhooks"],
  summary: "Create a webhook endpoint",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            url: z.string().url(),
            eventTypes: z.array(eventTypeEnum).min(1),
            description: z.string().max(500).optional(),
            disabled: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: webhookEndpointSchema.extend({ secret: z.string() }),
        },
      },
      description: "Endpoint created — signing secret shown only once",
    },
  },
});

const getEndpointRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Admin — Webhooks"],
  summary: "Get a webhook endpoint",
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: webhookEndpointSchema },
      },
      description: "Webhook endpoint (secret never included)",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Endpoint not found",
    },
  },
});

const updateEndpointRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Admin — Webhooks"],
  summary: "Update a webhook endpoint",
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            url: z.string().url().optional(),
            eventTypes: z.array(eventTypeEnum).min(1).optional(),
            description: z.string().max(500).nullable().optional(),
            disabled: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: webhookEndpointSchema },
      },
      description: "Updated webhook endpoint (secret never included)",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Endpoint not found",
    },
  },
});

const deleteEndpointRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Admin — Webhooks"],
  summary: "Delete a webhook endpoint",
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ deleted: z.boolean() }),
        },
      },
      description: "Endpoint hard-deleted (deliveries cascade)",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Endpoint not found",
    },
  },
});

const rotateSecretRoute = createRoute({
  method: "post",
  path: "/{id}/rotate-secret",
  tags: ["Admin — Webhooks"],
  summary: "Rotate a webhook endpoint's signing secret",
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            id: z.string(),
            secret: z.string(),
            secretPrefix: z.string(),
          }),
        },
      },
      description: "New signing secret — shown only once (hard cutover)",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Endpoint not found",
    },
  },
});

const testRoute = createRoute({
  method: "post",
  path: "/{id}/test",
  tags: ["Admin — Webhooks"],
  summary: "Send a test event to a webhook endpoint",
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    202: {
      content: {
        "application/json": {
          schema: z.object({
            enqueued: z.boolean(),
            eventType: z.literal("webhook.test"),
          }),
        },
      },
      description: "Out-of-band test event enqueued for delivery",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Endpoint not found",
    },
  },
});

/**
 * Serialize an endpoint row for an API response. NEVER includes `secret` — the
 * full `whsec_…` is surfaced only on create + rotate-secret via the dedicated
 * response shapes. `status` is derived from the `disabled` boolean.
 */
function serializeEndpoint(row: typeof webhookEndpoints.$inferSelect) {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    eventTypes: row.eventTypes as string[],
    secretPrefix: row.secretPrefix,
    status: (row.disabled ? "disabled" : "enabled") as "enabled" | "disabled",
    organizationId: row.organizationId,
    lastDeliveryAt: row.lastDeliveryAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const webhooksRouter = new OpenAPIHono<AppEnv>()
  .openapi(listRoute, async (c) => {
    const { db } = c.get("container");
    const { limit, offset, includeDisabled } = c.req.valid("query");

    const where =
      includeDisabled === "true"
        ? undefined
        : eq(webhookEndpoints.disabled, false);

    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(webhookEndpoints)
        .where(where)
        .orderBy(desc(webhookEndpoints.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: count() }).from(webhookEndpoints).where(where),
    ]);

    return c.json(
      {
        endpoints: rows.map(serializeEndpoint),
        total: totalRows[0]?.count ?? 0,
        limit,
        offset,
      },
      200,
    );
  })
  .openapi(createEndpointRoute, async (c) => {
    const { db } = c.get("container");
    const body = c.req.valid("json");

    const { secret, secretPrefix } = generateWebhookSecret();

    const [created] = await db
      .insert(webhookEndpoints)
      .values({
        url: body.url,
        eventTypes: body.eventTypes,
        description: body.description ?? null,
        disabled: body.disabled ?? false,
        secret,
        secretPrefix,
      })
      .returning();

    if (!created) throw new Error("Failed to create webhook endpoint");

    // The ONLY list/get-shaped response that also carries the full secret.
    return c.json({ ...serializeEndpoint(created), secret }, 201);
  })
  .openapi(getEndpointRoute, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");

    const [row] = await db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, id))
      .limit(1);

    if (!row) {
      return c.json({ error: "Webhook endpoint not found" }, 404);
    }

    return c.json(serializeEndpoint(row), 200);
  })
  .openapi(updateEndpointRoute, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const [existing] = await db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, id))
      .limit(1);

    if (!existing) {
      return c.json({ error: "Webhook endpoint not found" }, 404);
    }

    const patch: Partial<typeof webhookEndpoints.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (body.url !== undefined) patch.url = body.url;
    if (body.eventTypes !== undefined) patch.eventTypes = body.eventTypes;
    if (body.description !== undefined) patch.description = body.description;
    if (body.disabled !== undefined) patch.disabled = body.disabled;

    const [updated] = await db
      .update(webhookEndpoints)
      .set(patch)
      .where(eq(webhookEndpoints.id, id))
      .returning();

    if (!updated) {
      return c.json({ error: "Webhook endpoint not found" }, 404);
    }

    return c.json(serializeEndpoint(updated), 200);
  })
  .openapi(deleteEndpointRoute, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");

    // Hard delete (LOCKED: no soft-delete column). The FK cascade on
    // `webhook_deliveries.endpoint_id` drops this endpoint's delivery rows.
    const deleted = await db
      .delete(webhookEndpoints)
      .where(eq(webhookEndpoints.id, id))
      .returning({ id: webhookEndpoints.id });

    if (deleted.length === 0) {
      return c.json({ error: "Webhook endpoint not found" }, 404);
    }

    return c.json({ deleted: true }, 200);
  })
  .openapi(rotateSecretRoute, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");

    const { secret, secretPrefix } = generateWebhookSecret();

    // Hard cutover (LOCKED decision 10): the old secret is invalid immediately.
    // The delivery task reads the LIVE endpoint secret, so in-flight deliveries
    // re-sign with the new secret on their next attempt.
    const [updated] = await db
      .update(webhookEndpoints)
      .set({ secret, secretPrefix, updatedAt: new Date() })
      .where(eq(webhookEndpoints.id, id))
      .returning({ id: webhookEndpoints.id });

    if (!updated) {
      return c.json({ error: "Webhook endpoint not found" }, 404);
    }

    return c.json({ id: updated.id, secret, secretPrefix }, 200);
  })
  .openapi(testRoute, async (c) => {
    const { db, logger } = c.get("container");
    const { id } = c.req.valid("param");

    const [endpoint] = await db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, id))
      .limit(1);

    if (!endpoint) {
      return c.json({ error: "Webhook endpoint not found" }, 404);
    }

    // Out-of-band test (LOCKED decision 11): delivered regardless of the
    // endpoint's `eventTypes`. Build a synthetic delivery row directly — it does
    // NOT go through `emitOutbound` (which filters by subscription) — then enqueue
    // the same durable delivery task the live emit path uses.
    const webhookId = `msg_${randomUUID()}`;
    const timestamp = new Date();
    const envelope = {
      id: webhookId,
      type: "webhook.test" as const,
      timestamp: timestamp.toISOString(),
      data: {
        message: "Hogsend test event",
        endpointId: endpoint.id,
        sentAt: timestamp.toISOString(),
      },
    };

    const [delivery] = await db
      .insert(webhookDeliveries)
      .values({
        endpointId: endpoint.id,
        organizationId: endpoint.organizationId,
        webhookId,
        eventType: "webhook.test",
        dedupeKey: null,
        payload: envelope,
        status: "pending",
        attemptCount: 0,
        nextRetryAt: timestamp,
      })
      .returning({ id: webhookDeliveries.id });

    if (!delivery) throw new Error("Failed to enqueue webhook test delivery");

    // Enqueue-and-202 (LOCKED): tolerate a broker hiccup — the row is already
    // `pending` with `nextRetryAt <= now`, so the reaper re-drives it. Enqueue
    // fire-and-forget (mirrors the emit spine) so a slow/unreachable broker never
    // blocks the 202; a failed enqueue is logged, not surfaced as an error.
    void deliverWebhookTask
      .runNoWait({ deliveryId: delivery.id })
      .catch((error: unknown) => {
        logger.warn("webhooks/test: deliverWebhookTask enqueue failed", {
          endpointId: endpoint.id,
          deliveryId: delivery.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return c.json({ enqueued: true, eventType: "webhook.test" as const }, 202);
  });
