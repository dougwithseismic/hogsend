import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";

/**
 * Id-dispatched email-provider webhook receiver:
 * `POST /v1/webhooks/email/:providerId`.
 *
 * Resolves the provider from the container's {@link EmailProviderRegistry} (so
 * an unknown id is a clean 404) and dispatches into the engine's
 * `handleWebhook` flow. Registered BEFORE the `:sourceId` catch-all so Hono
 * matches the static `email/` prefix first.
 *
 * In this phase only the Resend provider exists, so the route still hands the
 * raw `{ payload, headers }` to `emailService.handleWebhook` (which verifies via
 * the active provider). The normalized `verifyWebhook → EmailEvent` signature —
 * where the route owns verification and dispatches a provider-neutral event —
 * lands in a later phase.
 */
const emailProviderWebhookRoute = createRoute({
  method: "post",
  path: "/v1/webhooks/email/{providerId}",
  tags: ["Webhooks"],
  summary: "Email provider webhook receiver",
  request: {
    params: z.object({ providerId: z.string() }),
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
      description: "Missing or invalid webhook signature",
    },
    404: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Unknown email provider",
    },
  },
});

export function registerEmailProviderRoutes(app: OpenAPIHono<AppEnv>) {
  app.openapi(emailProviderWebhookRoute, async (c) => {
    const { providerId } = c.req.valid("param");
    const { emailProviders, emailService, logger } = c.get("container");

    const provider = emailProviders.get(providerId);
    if (!provider) {
      return c.json({ error: "Unknown email provider" }, 404);
    }

    // Read the body ONCE as the EXACT received bytes — signature schemes verify
    // over these bytes, so we must not re-stringify.
    const payload = await c.req.text();
    const headers: Record<string, string> = {};
    for (const [key, value] of c.req.raw.headers.entries()) {
      headers[key.toLowerCase()] = value;
    }

    try {
      const result = await emailService.handleWebhook({ payload, headers });

      logger.info("Email provider webhook processed", {
        providerId,
        type: result.type,
        handled: result.handled,
      });

      return c.json({ ok: true }, 200);
    } catch (err) {
      logger.warn("Email provider webhook failed", {
        providerId,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "Webhook verification failed" }, 401);
    }
  });
}
