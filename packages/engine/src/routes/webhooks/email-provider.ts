import { WebhookHandshakeSignal } from "@hogsend/core";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";

/**
 * Id-dispatched email-provider webhook receiver:
 * `POST /v1/webhooks/email/:providerId`.
 *
 * Resolves the provider from the container's {@link EmailProviderRegistry} (so
 * an unknown id is a clean 404), verifies the webhook via that provider (which
 * owns its OWN secrets), and dispatches the normalized {@link EmailEvent} into
 * `emailService.handleWebhook`. Registered BEFORE the `:sourceId` catch-all so
 * Hono matches the static `email/` prefix first.
 *
 * The provider's `verifyWebhook` is the ONLY place body-shape knowledge lives —
 * the route never sniffs the payload. It returns a normalized event, OR throws
 * {@link WebhookHandshakeSignal} for non-status handshakes (route 200s), OR
 * throws a verification error (route 401s).
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
      const event = await provider.verifyWebhook({ payload, headers });
      const result = await emailService.handleWebhook(event, providerId);

      logger.info("Email provider webhook processed", {
        providerId,
        type: event.type,
        handled: result.handled,
      });

      return c.json({ ok: true }, 200);
    } catch (err) {
      if (err instanceof WebhookHandshakeSignal) {
        // A non-delivery-status handshake (SNS confirm, Postmark subscription
        // change) the provider already handled — ack with 200.
        logger.info("Email webhook handshake", {
          providerId,
          action: err.action,
        });
        return c.json({ ok: true }, 200);
      }
      logger.warn("Email provider webhook failed", {
        providerId,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "Webhook verification failed" }, 401);
    }
  });
}
