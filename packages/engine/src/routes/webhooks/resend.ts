import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";

const resendWebhookRoute = createRoute({
  method: "post",
  path: "/resend",
  tags: ["Webhooks"],
  summary:
    "Resend webhook receiver (@deprecated — use /v1/webhooks/email/resend)",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.record(z.string(), z.unknown()),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean() }),
        },
      },
      description: "Webhook processed",
    },
    401: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Missing or invalid webhook secret",
    },
    404: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Resend provider not registered",
    },
  },
});

export const resendWebhookRouter = new OpenAPIHono<AppEnv>().openapi(
  resendWebhookRoute,
  async (c) => {
    // Thin alias for `POST /v1/webhooks/email/resend`. Resolve the `resend`
    // provider from the registry so an unconfigured Resend deploy is a clean
    // 404 (not a confusing verify failure), then dispatch through the existing
    // handleWebhook flow.
    const { emailProviders, emailService, logger } = c.get("container");

    if (!emailProviders.get("resend")) {
      return c.json({ error: "Unknown email provider" }, 404);
    }

    const rawBody = await c.req.text();
    const headers: Record<string, string> = {};
    for (const [key, value] of c.req.raw.headers.entries()) {
      headers[key] = value;
    }

    try {
      const result = await emailService.handleWebhook({
        payload: rawBody,
        headers,
      });

      logger.info("Resend webhook processed", {
        type: result.type,
        handled: result.handled,
      });

      return c.json({ ok: true }, 200);
    } catch (err) {
      logger.warn("Resend webhook failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "Webhook verification failed" }, 401);
    }
  },
);
