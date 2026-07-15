import { z } from "zod";
import { identifyGroup } from "../../lib/groups.js";
import type { IngestEvent } from "../../lib/ingestion.js";
import {
  defineWebhookSource,
  type WebhookSourceCtx,
} from "../define-webhook-source.js";

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
 *  - `group`    → `segment.group`: writes the `company` group + its traits and
 *    associates the contact (Segment's group model is single-type). The webhook
 *    is HMAC-signed (trusted server-to-server), so writing group PROPERTIES from
 *    it is safe — unlike a publishable browser key, which may only associate.
 *  - `page` / `screen` / `alias` → skipped (`null`)
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
    // Segment `group` calls carry the group's external id here.
    groupId: z.string().nullish(),
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
  async transform(
    payload: SegmentPayload,
    ctx: WebhookSourceCtx,
  ): Promise<IngestEvent | null> {
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

    if (payload.type === "group") {
      // Segment's `group` call: a company/account association plus its traits.
      // Single-type group model → default the groupType to "company".
      const groupId = payload.groupId ?? undefined;
      if (!groupId) {
        return null;
      }

      // (1) Write the group + its traits. Safe because the Segment webhook is
      // HMAC-signed (trusted server-to-server). NOTE: the outbound
      // `group.identified` webhook does NOT fire from here — a webhook-source
      // `ctx` has no `hatchet`; the `POST /v1/groups` HTTP route owns that
      // fan-out. This path still lands the group, its traits, AND (via the
      // returned IngestEvent) the membership + Events-feed observability.
      await identifyGroup({
        db: ctx.db,
        groupType: "company",
        groupKey: groupId,
        properties: traits,
        logger: ctx.logger,
      });

      // (2) Carry the association so the ingest pipeline resolves the contact
      // and creates the MEMBERSHIP via the existing associateGroups path.
      return {
        event: "segment.group",
        userId,
        userEmail,
        groups: { company: groupId },
        eventProperties: {
          source: "segment",
          _segmentType: "group",
          groupId,
        },
        contactProperties: {},
        ...(idempotencyKey ? { idempotencyKey } : {}),
      };
    }

    // page / screen / alias → skip.
    return null;
  },
});
