import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { ingestEvent } from "../../lib/ingestion.js";
import type { DefinedWebhookSource } from "../../webhook-sources/define-webhook-source.js";

export function registerWebhookSourceRoutes(
  app: OpenAPIHono<AppEnv>,
  sources: DefinedWebhookSource[],
) {
  const sourceMap = new Map(sources.map((s) => [s.meta.id, s]));

  const webhookRoute = createRoute({
    method: "post",
    path: "/v1/webhooks/{sourceId}",
    request: {
      params: z.object({ sourceId: z.string() }),
    },
    responses: {
      200: {
        description: "Webhook accepted",
        content: {
          "application/json": {
            schema: z.object({
              ok: z.boolean(),
              skipped: z.boolean().optional(),
              event: z.string().optional(),
              userId: z.string().optional(),
              exits: z.number().optional(),
            }),
          },
        },
      },
      400: {
        description: "Invalid payload",
      },
      401: {
        description: "Unauthorized",
      },
      404: {
        description: "Source not found",
      },
    },
  });

  app.openapi(webhookRoute, async (c) => {
    const { sourceId } = c.req.valid("param");
    const source = sourceMap.get(sourceId);

    if (!source) {
      return c.json({ error: "Unknown webhook source" }, 404);
    }

    const { db, logger, env, registry, hatchet } = c.get("container");

    // Auth is enforced only when the source's secret is configured. An
    // unconfigured source is treated as open (parity with the pre-engine route).
    const secret = env[source.auth.envKey as keyof typeof env] as
      | string
      | undefined;
    if (secret) {
      const provided =
        c.req.header(source.auth.header) ??
        c.req.header("authorization")?.replace("Bearer ", "");

      if (provided !== secret) {
        return c.json({ error: "Invalid webhook secret" }, 401);
      }
    }

    let payload: unknown = await c.req.json();
    if (source.schema) {
      const parsed = source.schema.safeParse(payload);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid payload", details: parsed.error.flatten() },
          400,
        );
      }
      payload = parsed.data;
    }

    const event = await source.transform(payload, { db, logger });
    if (!event) {
      logger.info("Webhook event skipped", { source: sourceId });
      return c.json({ ok: true, skipped: true });
    }

    const result = await ingestEvent({ db, registry, hatchet, logger, event });

    return c.json({
      ok: true,
      event: event.event,
      userId: event.userId,
      exits: result.exits,
    });
  });
}
