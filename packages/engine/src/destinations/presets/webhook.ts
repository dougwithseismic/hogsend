import { signWebhook, WEBHOOK_EVENT_TYPES } from "../../lib/webhook-signing.js";
import { defineDestination } from "../define-destination.js";

/**
 * The DEFAULT destination — the signed Standard-Webhooks POST every existing
 * subscriber receives. BYTE-IDENTICAL to the pre-destination delivery: the same
 * `signWebhook` arguments (id = the envelope id, timestamp = current epoch
 * seconds, payload = the frozen envelope, secret = the live endpoint secret) and
 * the exact signed bytes + headers, POSTed to the raw `endpoint.url`.
 *
 * Its `meta.id` is `"webhook"`, so an endpoint with `kind = "webhook"` (the
 * column default) resolves here. This preset is ALWAYS registered, so the
 * critical no-regression invariant holds even when a consumer wires no
 * destinations of their own.
 */
export const webhookDestination = defineDestination({
  meta: {
    id: "webhook",
    name: "Signed webhook",
    description:
      "The default Standard-Webhooks signed POST to a subscriber URL (Svix HMAC).",
  },
  // The default signed webhook fans out the WHOLE outbound catalog — it is the
  // generic subscriber transport, not a per-vendor projection.
  events: [...WEBHOOK_EVENT_TYPES],
  transform(envelope, ctx) {
    const { headers, body } = signWebhook({
      id: envelope.id,
      // Same expression the pre-destination delivery task used, so the signature
      // matches the body the task sends.
      timestamp: Math.floor(Date.now() / 1000),
      payload: envelope,
      secret: ctx.endpoint.secret ?? "",
    });
    return { url: ctx.endpoint.url, headers, body };
  },
});
