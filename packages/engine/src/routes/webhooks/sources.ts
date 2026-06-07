import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { ingestEvent } from "../../lib/ingestion.js";
import type { DefinedWebhookSource } from "../../webhook-sources/define-webhook-source.js";
import { verifySignature } from "../../webhook-sources/verify.js";

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

    // Read the body ONCE as the EXACT received bytes — signature schemes verify
    // over these bytes, so we must not re-stringify. JSON.parse only AFTER auth.
    const rawBody = await c.req.text();
    const headers: Record<string, string> = {};
    for (const [key, value] of c.req.raw.headers.entries()) {
      headers[key.toLowerCase()] = value;
    }

    const secret = env[source.auth.envKey as keyof typeof env] as
      | string
      | undefined;

    if (source.auth.type === "signature") {
      // Signature sources FAIL CLOSED: an unset secret is a 401, never an open
      // pass-through (deliberate divergence from the "match" variant).
      if (!secret) {
        logger.warn("Webhook signature secret not configured", {
          source: sourceId,
        });
        return c.json({ error: "Webhook signature not configured" }, 401);
      }

      const auth = source.auth;
      let verified = false;

      if (auth.verify) {
        verified = await auth.verify({ rawBody, headers, secret });
      } else {
        verified = verifySignature(
          auth.scheme,
          { rawBody, headers, secret },
          auth.header,
        );
      }

      // Optional plain shared-secret fallback (e.g. Supabase's
      // `x-supabase-webhook-secret`) when the signature headers are absent.
      if (!verified && auth.fallbackMatchHeader) {
        const provided = headers[auth.fallbackMatchHeader.toLowerCase()];
        verified = provided === secret;
      }

      if (!verified) {
        return c.json({ error: "Invalid webhook signature" }, 401);
      }
    } else {
      // "match": shared-secret equality. An unconfigured source stays OPEN
      // (parity with the pre-engine route).
      if (secret) {
        const provided =
          headers[source.auth.header.toLowerCase()] ??
          headers.authorization?.replace("Bearer ", "");

        if (provided !== secret) {
          return c.json({ error: "Invalid webhook secret" }, 401);
        }
      }
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json(
        { error: "Invalid payload", details: "Malformed JSON" },
        400,
      );
    }

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

    const event = await source.transform(payload, {
      db,
      logger,
      rawBody,
      headers,
    });
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
