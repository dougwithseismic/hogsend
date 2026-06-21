import { defineWebhookSource } from "@hogsend/engine";
import { z } from "zod";

/**
 * Eve webhook source — Tier-3 durable HITL callback.
 *
 * Eve POSTs a callback here when its agent session completes (terminal state:
 * approved, rejected, or errored). The journey parked on
 * `ctx.waitForEvent(Events.AGENT_COMPLETED)` resumes automatically when this
 * event flows through the ingest spine.
 *
 * Auth: HMAC-SHA256 signature over the raw request body, sent as lowercase
 * hex in the `x-eve-signature` header (the engine's `hmac-hex` scheme, same as
 * the Segment preset). `EVE_WEBHOOK_SECRET` must be set to the same value in
 * both Hogsend and the Eve service. A `signature` source FAILS CLOSED — an
 * unset secret or a missing/incorrect signature is a 401, never an open
 * pass-through. In production always set `EVE_WEBHOOK_SECRET` to a high-entropy
 * random string. The engine resolves `EVE_WEBHOOK_SECRET` from `process.env`
 * (a consumer-defined source secret not declared in the engine env schema).
 *
 * Payload shape (what Eve sends):
 * ```json
 * {
 *   "sessionId": "ses_...",
 *   "userId":    "usr_...",
 *   "event":     "agent.completed",
 *   "play": {
 *     "action":  "offer_discount" | "book_call" | "suppress",
 *     "reason":  "...",
 *     "detail":  "..." // optional
 *   }
 * }
 * ```
 */

const evePlaySchema = z.object({
  action: z.string(),
  reason: z.string(),
  detail: z.string().optional(),
});

const eveCallbackSchema = z.object({
  sessionId: z.string(),
  userId: z.string(),
  /** The event name Eve passes back — should match `Events.AGENT_COMPLETED`. */
  event: z.string(),
  play: evePlaySchema,
});

export type EvePlay = z.infer<typeof evePlaySchema>;
export type EveCallback = z.infer<typeof eveCallbackSchema>;

/**
 * Zod schema for the `play` object that the journey extracts from the
 * `ctx.waitForEvent` result's `properties`. Exported so the journey can parse
 * and validate the agent's terminal decision.
 */
export const SavePlay = evePlaySchema;

export const eveSource = defineWebhookSource({
  meta: {
    id: "eve",
    name: "Eve Agent",
    description:
      "Receives completion callbacks from the Eve agent platform. " +
      "Resumes a parked churn-save journey when an agent session terminates.",
  },
  // HMAC-SHA256 over the raw body, hex-encoded in `x-eve-signature`. A
  // `signature` source FAILS CLOSED: an unset secret or a bad/missing signature
  // is a 401 (never an open pass-through). The engine resolves the secret from
  // process.env since EVE_WEBHOOK_SECRET is a consumer var, not an engine preset.
  auth: {
    type: "signature",
    scheme: "hmac-hex",
    header: "x-eve-signature",
    envKey: "EVE_WEBHOOK_SECRET",
  },
  schema: eveCallbackSchema,
  async transform(payload): Promise<{
    event: string;
    userId: string;
    userEmail: string;
    eventProperties: Record<string, unknown>;
    contactProperties?: Record<string, unknown>;
  } | null> {
    const { userId, event, play } = payload;

    if (!userId) {
      return null;
    }

    return {
      event,
      userId,
      userEmail: "",
      // Serialize the play as scalar-safe event properties so
      // ctx.waitForEvent's `properties` bag carries it cleanly.
      eventProperties: {
        sessionId: payload.sessionId,
        playAction: play.action,
        playReason: play.reason,
        ...(play.detail !== undefined ? { playDetail: play.detail } : {}),
        _eveSource: true,
      },
      contactProperties: {},
    };
  },
});
