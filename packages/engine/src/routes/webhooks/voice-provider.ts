import { WebhookHandshakeSignal } from "@hogsend/core";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../../app.js";
import { env } from "../../env.js";
import { headersToRecord } from "../../lib/headers.js";
import { ingestEvent } from "../../lib/ingestion.js";

/**
 * Shared voice-provider webhook dispatch for
 * `POST /v1/webhooks/voice/:providerId`. Resolves the provider from the
 * container's {@link VoiceProviderRegistry} (404 on unknown id), reads the raw
 * body, builds the canonical PUBLIC url, verifies, and handles the normalized
 * {@link VoiceWebhookParsed}:
 *
 * - `tool_call` → run the mid-call tool dispatcher and reply SYNCHRONOUSLY with
 *   the provider-encoded results (the provider blocks the conversation on this
 *   reply).
 * - `event` → advance call status / persist the outcome, then push the returned
 *   journey-bus events through `ingestEvent` so a `ctx.waitForEvent` wakes.
 *
 * 200s a {@link WebhookHandshakeSignal} (intermediate status / unhandled), 401s
 * a verification error.
 */
export async function dispatchVoiceProviderWebhook(
  c: Context<AppEnv>,
  providerId: string,
) {
  const {
    voiceProviders,
    voiceService,
    registry,
    hatchet,
    analytics,
    db,
    logger,
  } = c.get("container");

  const provider = voiceProviders.get(providerId);
  if (!provider) {
    return c.json({ error: "Unknown voice provider" }, 404);
  }

  const payload = await c.req.text();
  const headers = headersToRecord(c.req.raw.headers);

  const requestUrl = new URL(c.req.url);
  const base = env.API_PUBLIC_URL.replace(/\/+$/, "");
  const url = `${base}${requestUrl.pathname}${requestUrl.search}`;

  try {
    const parsed = await provider.verifyWebhook({ payload, headers, url });

    if (parsed.kind === "tool_call") {
      const results = await voiceService.dispatchToolCalls(parsed.calls);
      logger.info("Voice tool calls dispatched", {
        providerId,
        count: parsed.calls.length,
      });
      // The provider blocks on this exact body shape.
      return c.json(provider.encodeToolResults(results) as object, 200);
    }

    if (parsed.kind === "assistant_request") {
      // INBOUND call: select + synthesize the inbound agent, then reply with the
      // provider's assistant-response shape (the provider blocks on it). Vapi
      // requires this reply within ~7.5s.
      const agentConfig = await voiceService.handleAssistantRequest(
        parsed.request,
      );
      const body = provider.encodeAssistantResponse
        ? provider.encodeAssistantResponse(agentConfig)
        : { error: "inbound not supported" };
      return c.json(body as object, 200);
    }

    const result = await voiceService.handleWebhook(parsed.event, providerId);
    // Wake journeys waiting on the call outcome. `ingestEvent` needs the
    // container's registry/analytics the service does not hold, so it runs here.
    // AWAITED + idempotency-keyed: a failure returns 500 so Vapi RETRIES the
    // webhook and re-ingests (the key dedups), rather than losing the outcome —
    // the status advance is independent of the ingest, so a retry still wakes
    // the waiting journey.
    let ingestFailed = false;
    for (const ing of result.ingest ?? []) {
      try {
        await ingestEvent({
          db,
          registry,
          hatchet,
          logger,
          ...(analytics ? { analytics } : {}),
          event: {
            event: ing.event,
            userId: ing.userId,
            eventProperties: ing.properties,
            ...(ing.contactProperties
              ? { contactProperties: ing.contactProperties }
              : {}),
            ...(ing.idempotencyKey
              ? { idempotencyKey: ing.idempotencyKey }
              : {}),
            source: "voice",
          },
        });
      } catch (err: unknown) {
        ingestFailed = true;
        logger.warn("voice ingest failed", {
          event: ing.event,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    logger.info("Voice provider webhook processed", {
      providerId,
      type: parsed.event.type,
      handled: result.handled,
    });
    if (ingestFailed) {
      return c.json({ error: "ingest failed, retry" }, 500);
    }
    return c.json({ received: true }, 200);
  } catch (err) {
    if (err instanceof WebhookHandshakeSignal) {
      logger.info("Voice webhook handshake", {
        providerId,
        action: err.action,
      });
      return c.json({ received: true }, 200);
    }
    logger.warn("Voice provider webhook failed", {
      providerId,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: "Webhook verification failed" }, 401);
  }
}

const voiceProviderWebhookRoute = createRoute({
  method: "post",
  path: "/v1/webhooks/voice/{providerId}",
  tags: ["Webhooks"],
  summary: "Voice provider webhook receiver (status, end-of-call, tool calls)",
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
    200: { description: "Webhook processed (or tool-call results)" },
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
      description: "Unknown voice provider",
    },
  },
});

export function registerVoiceProviderRoutes(app: OpenAPIHono<AppEnv>) {
  app.openapi(voiceProviderWebhookRoute, (c) => {
    const { providerId } = c.req.valid("param");
    return dispatchVoiceProviderWebhook(c, providerId);
  });
}
