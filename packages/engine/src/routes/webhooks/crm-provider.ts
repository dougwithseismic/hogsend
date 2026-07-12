import { WebhookHandshakeSignal } from "@hogsend/core";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../../app.js";
import { env } from "../../env.js";
import { ingestCrmStageEvents } from "../../lib/crm-ingest.js";
import { headersToRecord } from "../../lib/headers.js";

/**
 * CRM-provider webhook dispatch for `POST /v1/webhooks/crm/:providerId` — the
 * CRM sibling of the email/SMS provider routes. Resolves the provider from
 * the container's {@link CrmProviderRegistry} (404 on unknown id), verifies
 * with the EXACT received bytes + canonical public URL, and lands the
 * normalized {@link CrmStageEvent}s on the spine via
 * {@link ingestCrmStageEvents} (idempotent against the reconciliation poll).
 */
export async function dispatchCrmProviderWebhook(
  c: Context<AppEnv>,
  providerId: string,
) {
  const {
    crmProviders,
    crmStageMaps,
    crmLadder,
    db,
    registry,
    hatchet,
    logger,
    analytics,
  } = c.get("container");

  const provider = crmProviders.get(providerId);
  if (!provider) {
    return c.json({ error: "Unknown CRM provider" }, 404);
  }

  const payload = await c.req.text();
  const headers = headersToRecord(c.req.raw.headers);

  const requestUrl = new URL(c.req.url);
  const base = env.API_PUBLIC_URL.replace(/\/+$/, "");
  const url = `${base}${requestUrl.pathname}${requestUrl.search}`;

  try {
    const events = await provider.verifyWebhook({ payload, headers, url });
    const result = await ingestCrmStageEvents({
      db,
      registry,
      hatchet,
      logger,
      analytics,
      providerId,
      events,
      stageMap: crmStageMaps[providerId],
      ladder: crmLadder,
    });
    logger.info("CRM provider webhook processed", {
      providerId,
      events: events.length,
      ...result,
    });
    return c.json({ received: events.length, ...result }, 200);
  } catch (err) {
    if (err instanceof WebhookHandshakeSignal) {
      logger.info("CRM webhook handshake", { providerId, action: err.action });
      return c.json({ ok: true }, 200);
    }
    logger.warn("CRM provider webhook failed", {
      providerId,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: "Webhook verification failed" }, 401);
  }
}

const crmProviderWebhookRoute = createRoute({
  method: "post",
  path: "/v1/webhooks/crm/{providerId}",
  tags: ["Webhooks"],
  summary:
    "CRM provider webhook receiver (pipeline stage changes + deal values)",
  request: {
    params: z.object({ providerId: z.string() }),
    body: {
      content: {
        // Providers post arbitrary JSON (object OR array); verification reads
        // the raw bytes, so the schema is deliberately permissive.
        "application/json": { schema: z.unknown() },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            received: z.number().optional(),
            ingested: z.number().optional(),
            skipped: z.number().optional(),
            ok: z.boolean().optional(),
          }),
        },
      },
      description: "Webhook processed",
    },
    401: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Missing or invalid webhook signature",
    },
    404: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Unknown CRM provider",
    },
  },
});

export function registerCrmProviderRoutes(app: OpenAPIHono<AppEnv>) {
  app.openapi(crmProviderWebhookRoute, (c) => {
    const { providerId } = c.req.valid("param");
    return dispatchCrmProviderWebhook(c, providerId);
  });
}
