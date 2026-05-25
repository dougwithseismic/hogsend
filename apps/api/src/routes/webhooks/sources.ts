import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { ingestEvent } from "../../lib/ingestion.js";
import { getWebhookSources } from "../../webhook-sources/index.js";

const sources = getWebhookSources();

export const webhookSourceRouter = new OpenAPIHono<AppEnv>();

webhookSourceRouter.post("/:sourceId", async (c) => {
  const sourceId = c.req.param("sourceId");
  const source = sources.get(sourceId);

  if (!source) {
    return c.json({ error: "Unknown webhook source" }, 404);
  }

  const { db, logger, env, registry, hatchet } = c.get("container");

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

  let payload: unknown;
  if (source.schema) {
    const raw = await c.req.json();
    const parsed = source.schema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid payload", details: parsed.error.flatten() },
        400,
      );
    }
    payload = parsed.data;
  } else {
    payload = await c.req.json();
  }

  const event = await source.transform(payload, { db, logger });

  if (!event) {
    logger.info("Webhook event skipped", { source: sourceId });
    return c.json({ ok: true, skipped: true }, 200);
  }

  logger.info("Webhook event received", {
    source: sourceId,
    event: event.event,
    userId: event.userId,
    hasEmail: !!event.userEmail,
  });

  const result = await ingestEvent({
    db,
    registry,
    hatchet,
    logger,
    event,
  });

  return c.json(
    {
      ok: true,
      event: event.event,
      userId: event.userId,
      exits: result.exits,
    },
    200,
  );
});
