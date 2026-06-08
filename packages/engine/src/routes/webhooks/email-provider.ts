import { WebhookHandshakeSignal } from "@hogsend/core";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../../app.js";
import { headersToRecord } from "../../lib/headers.js";

/**
 * Shared email-provider webhook dispatch used by BOTH the id-dispatched
 * `POST /v1/webhooks/email/:providerId` route and the thin
 * `POST /v1/webhooks/resend` alias. Resolves the provider from the container's
 * {@link EmailProviderRegistry} (404 on unknown id), reads the raw body as the
 * EXACT received bytes (signature schemes verify over these), verifies +
 * dispatches the normalized {@link EmailEvent}, 200s a
 * {@link WebhookHandshakeSignal}, and 401s a verification error.
 */
export async function dispatchProviderWebhook(
  c: Context<AppEnv>,
  providerId: string,
) {
  const { emailProviders, emailService, logger } = c.get("container");

  const provider = emailProviders.get(providerId);
  if (!provider) {
    return c.json({ error: "Unknown email provider" }, 404);
  }

  // Read the body ONCE as the EXACT received bytes — signature schemes verify
  // over these bytes, so we must not re-stringify.
  const payload = await c.req.text();
  const headers = headersToRecord(c.req.raw.headers);

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
}

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
  app.openapi(emailProviderWebhookRoute, (c) => {
    const { providerId } = c.req.valid("param");
    return dispatchProviderWebhook(c, providerId);
  });
}
