import { WebhookHandshakeSignal } from "@hogsend/core";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../../app.js";
import { env } from "../../env.js";
import { headersToRecord } from "../../lib/headers.js";

/**
 * Shared SMS-provider webhook dispatch for
 * `POST /v1/webhooks/sms/:providerId`. Resolves the provider from the
 * container's {@link SmsProviderRegistry} (404 on unknown id), reads the raw
 * body as the EXACT received bytes, builds the canonical PUBLIC url (Twilio
 * signs `API_PUBLIC_URL + path + query`, NOT `c.req.url` which has the wrong
 * host behind a proxy), verifies + dispatches the normalized {@link SmsEvent},
 * 200s a {@link WebhookHandshakeSignal} (intermediate status / unrecognized),
 * and 401s a verification error.
 *
 * Responds with an empty TwiML document — Twilio's inbound MO webhook expects
 * TwiML; status callbacks accept any 2xx.
 */
export async function dispatchSmsProviderWebhook(
  c: Context<AppEnv>,
  providerId: string,
) {
  const { smsProviders, smsService, logger } = c.get("container");

  const provider = smsProviders.get(providerId);
  if (!provider) {
    return c.json({ error: "Unknown SMS provider" }, 404);
  }

  const payload = await c.req.text();
  const headers = headersToRecord(c.req.raw.headers);

  // Canonical public URL the provider signed: API_PUBLIC_URL + path (+ query).
  // Twilio's HMAC covers the URL string byte-for-byte, so normalize the one
  // operator-controlled degree of freedom — a trailing slash on
  // API_PUBLIC_URL would otherwise 401 EVERY callback and inbound STOP.
  const requestUrl = new URL(c.req.url);
  const base = env.API_PUBLIC_URL.replace(/\/+$/, "");
  const url = `${base}${requestUrl.pathname}${requestUrl.search}`;

  try {
    const event = await provider.verifyWebhook({ payload, headers, url });
    const result = await smsService.handleWebhook(event, providerId);
    logger.info("SMS provider webhook processed", {
      providerId,
      type: event.type,
      handled: result.handled,
    });
    return c.body(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
      200,
      { "Content-Type": "text/xml" },
    );
  } catch (err) {
    if (err instanceof WebhookHandshakeSignal) {
      logger.info("SMS webhook handshake", { providerId, action: err.action });
      return c.body(
        '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
        200,
        { "Content-Type": "text/xml" },
      );
    }
    logger.warn("SMS provider webhook failed", {
      providerId,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: "Webhook verification failed" }, 401);
  }
}

const smsProviderWebhookRoute = createRoute({
  method: "post",
  path: "/v1/webhooks/sms/{providerId}",
  tags: ["Webhooks"],
  summary: "SMS provider webhook receiver (status callbacks + inbound STOP)",
  request: {
    params: z.object({ providerId: z.string() }),
    body: {
      content: {
        "application/x-www-form-urlencoded": {
          schema: z.record(z.string(), z.unknown()),
        },
      },
    },
  },
  responses: {
    200: { description: "Webhook processed (empty TwiML)" },
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
      description: "Unknown SMS provider",
    },
  },
});

export function registerSmsProviderRoutes(app: OpenAPIHono<AppEnv>) {
  app.openapi(smsProviderWebhookRoute, (c) => {
    const { providerId } = c.req.valid("param");
    return dispatchSmsProviderWebhook(c, providerId);
  });
}
