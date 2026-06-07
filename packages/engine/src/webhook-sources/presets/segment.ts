import { z } from "zod";
import type { IngestEvent } from "../../lib/ingestion.js";
import { defineWebhookSource } from "../define-webhook-source.js";

/**
 * Segment webhook preset.
 *
 * Auth: generic HMAC-hex over the raw body (`x-signature`), verified with
 * `node:crypto`. Set `SEGMENT_WEBHOOK_SECRET` to auto-enable at
 * `POST /v1/webhooks/segment`.
 *
 * Event mapping (decision #16):
 *  - `identify` → `contact.updated` (traits → `contactProperties` ONLY)
 *  - `track`    → the literal `event` name (properties → `eventProperties` ONLY)
 *  - `page` / `screen` / `group` / `alias` → skipped (`null`)
 *
 * Identity: `userId = userId ?? anonymousId`; `email` lifted from
 * `traits.email`/`context.traits.email`. `idempotencyKey = messageId` so
 * Segment redelivery dedupes on `user_events.idempotencyKey`.
 */

const segmentTraitsSchema = z.record(z.string(), z.unknown());

const segmentWebhookSchema = z
  .object({
    type: z.string(),
    event: z.string().nullish(),
    messageId: z.string().nullish(),
    userId: z.string().nullish(),
    anonymousId: z.string().nullish(),
    traits: segmentTraitsSchema.nullish(),
    properties: z.record(z.string(), z.unknown()).nullish(),
    context: z
      .object({
        traits: segmentTraitsSchema.nullish(),
      })
      .catchall(z.unknown())
      .nullish(),
  })
  .catchall(z.unknown());

type SegmentPayload = z.infer<typeof segmentWebhookSchema>;

/** Pull a string email out of a traits bag, if present. */
function emailFromTraits(
  traits: Record<string, unknown> | null | undefined,
): string | undefined {
  const email = traits?.email;
  return typeof email === "string" ? email : undefined;
}

export const segmentSource = defineWebhookSource({
  meta: {
    id: "segment",
    name: "Segment",
    description: "Receives Segment identify/track webhooks (HMAC-hex signed).",
  },
  auth: {
    type: "signature",
    scheme: "hmac-hex",
    envKey: "SEGMENT_WEBHOOK_SECRET",
    header: "x-signature",
  },
  schema: segmentWebhookSchema,
  async transform(payload: SegmentPayload): Promise<IngestEvent | null> {
    const userId = payload.userId ?? payload.anonymousId ?? undefined;
    if (!userId) {
      return null;
    }

    const traits = payload.traits ?? payload.context?.traits ?? undefined;
    const userEmail =
      emailFromTraits(payload.traits) ??
      emailFromTraits(payload.context?.traits) ??
      "";
    const idempotencyKey = payload.messageId ?? undefined;

    if (payload.type === "identify") {
      // identify: traits are profile/identity → contactProperties ONLY.
      const contactProperties: Record<string, unknown> = { ...(traits ?? {}) };
      contactProperties.source = "segment";

      return {
        event: "contact.updated",
        userId,
        userEmail,
        eventProperties: {
          source: "segment",
          _segmentType: "identify",
        },
        contactProperties,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      };
    }

    if (payload.type === "track") {
      const eventName = payload.event;
      if (!eventName) {
        return null;
      }
      // track: properties are behavioral → eventProperties ONLY.
      const eventProperties: Record<string, unknown> = {
        ...(payload.properties ?? {}),
      };
      eventProperties.source = "segment";

      return {
        event: eventName,
        userId,
        userEmail,
        eventProperties,
        contactProperties: {},
        ...(idempotencyKey ? { idempotencyKey } : {}),
      };
    }

    // page / screen / group / alias → skip.
    return null;
  },
});
