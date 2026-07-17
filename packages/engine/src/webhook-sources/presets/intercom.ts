import { createHmac } from "node:crypto";
import { z } from "zod";
import type { IngestEvent } from "../../lib/ingestion.js";
import { defineWebhookSource } from "../define-webhook-source.js";
import { safeEqual } from "../verify.js";

/**
 * Intercom (incl. Fin) webhook preset — support/chat as a lifecycle trigger.
 *
 * Auth: Intercom signs each delivery with `X-Hub-Signature: sha1=<hex>`, an
 * HMAC-SHA1 of the RAW request body keyed with the app's client secret. The
 * engine's built-in signature schemes are all SHA-256, so this preset uses the
 * `signature` variant's custom `verify` escape hatch to recompute the SHA1 and
 * constant-time compare via the shared {@link safeEqual}. Set
 * `INTERCOM_CLIENT_SECRET` (your Intercom app's Client Secret) to auto-enable at
 * `POST /v1/webhooks/intercom`. FAIL CLOSED when unset (the route 401s a
 * `signature` source with no secret before this transform ever runs).
 *
 * Event mapping (Intercom notification `topic` → Hogsend `support.*`):
 *  - `conversation.user.created`   → `support.conversation_started`
 *  - `conversation.admin.closed`   → `support.resolved`   (incl. Fin closes)
 *  - `conversation.admin.assigned` → `support.escalated`  (handed to a human)
 *  - `conversation.rating.added`   → `support.rated`       (CSAT; carries `rating`)
 *  - anything else                 → `null` (skipped)
 *
 * Identity (load-bearing — folds onto the SAME Hogsend contact as the person's
 * product/email activity): `userId` is the Intercom contact's `external_id`
 * (the customer's OWN app user id) when present, so the resolver keys on the
 * identified canonical key rather than minting a phantom twin. `userEmail` is
 * always passed when Intercom has it (co-resolution key; the SOLE key when there
 * is no `external_id`). Intercom's INTERNAL contact id is recorded as
 * `contactProperties.intercomContactId` for reference ONLY, never as identity.
 * With neither an `external_id` nor an email, the event can't be placed on a
 * person and the transform returns `null`.
 *
 * D2 split: profile (`name`, `intercomContactId`) → `contactProperties`;
 * conversation metadata (`conversationId`, `isAiResolved`, assignee/team,
 * `rating`, `topic`) → `eventProperties`. `idempotencyKey = intercom:<id>`
 * uses the notification envelope `id` (unique per delivery), mirroring Stripe.
 */

const intercomPersonSchema = z
  .object({
    type: z.string().nullish(),
    id: z.string().nullish(),
    external_id: z.string().nullish(),
    email: z.string().nullish(),
    name: z.string().nullish(),
  })
  .catchall(z.unknown());

const intercomItemSchema = z
  .object({
    type: z.string().nullish(),
    id: z.string().nullish(),
    source: z
      .object({ author: intercomPersonSchema.nullish() })
      .catchall(z.unknown())
      .nullish(),
    // Intercom nests participating contacts under `contacts.contacts[]`.
    contacts: z
      .object({ contacts: z.array(intercomPersonSchema).nullish() })
      .catchall(z.unknown())
      .nullish(),
    admin_assignee_id: z.union([z.string(), z.number()]).nullish(),
    team_assignee_id: z.union([z.string(), z.number()]).nullish(),
    conversation_rating: z
      .object({ rating: z.number().nullish() })
      .catchall(z.unknown())
      .nullish(),
    // Present on conversations Fin (the AI agent) participated in.
    ai_agent_participated: z.boolean().nullish(),
  })
  .catchall(z.unknown());

const intercomWebhookSchema = z
  .object({
    type: z.string().nullish(),
    id: z.string(),
    topic: z.string(),
    data: z.object({ item: intercomItemSchema }).catchall(z.unknown()),
  })
  .catchall(z.unknown());

type IntercomPayload = z.infer<typeof intercomWebhookSchema>;
type IntercomPerson = z.infer<typeof intercomPersonSchema>;

/** Intercom notification `topic` → Hogsend `support.*` event. */
const TOPIC_EVENT_MAP: Record<string, string> = {
  "conversation.user.created": "support.conversation_started",
  "conversation.admin.closed": "support.resolved",
  "conversation.admin.assigned": "support.escalated",
  "conversation.rating.added": "support.rated",
};

interface ResolvedIdentity {
  externalId?: string;
  email?: string;
  name?: string;
  intercomContactId?: string;
}

/**
 * Resolve the human on the conversation. Only real people (the conversation
 * author when it's a user/contact/lead, plus every participating contact) are
 * candidates — an admin/bot author is skipped so a teammate's id never becomes
 * the contact key. `external_id` (the customer's own app user id) and `email`
 * are taken from the FIRST candidate that carries each; the Intercom internal
 * contact id is captured for reference only.
 */
function resolveIdentity(
  item: IntercomPayload["data"]["item"],
): ResolvedIdentity {
  const candidates: IntercomPerson[] = [];
  const author = item.source?.author;
  if (
    author &&
    (author.type === "user" ||
      author.type === "contact" ||
      author.type === "lead")
  ) {
    candidates.push(author);
  }
  candidates.push(...(item.contacts?.contacts ?? []));

  // Keep the first non-empty string seen for a field across the candidates.
  const firstOf = (current: string | undefined, next: unknown) =>
    current ?? (typeof next === "string" && next.length > 0 ? next : undefined);

  const resolved: ResolvedIdentity = {};
  for (const person of candidates) {
    resolved.externalId = firstOf(resolved.externalId, person.external_id);
    resolved.email = firstOf(resolved.email, person.email);
    resolved.name = firstOf(resolved.name, person.name);
    resolved.intercomContactId = firstOf(resolved.intercomContactId, person.id);
  }
  return resolved;
}

export const intercomSource = defineWebhookSource({
  meta: {
    id: "intercom",
    name: "Intercom",
    description:
      "Receives Intercom/Fin conversation webhooks as support.* lifecycle events (X-Hub SHA1 signature-verified).",
  },
  auth: {
    type: "signature",
    // `scheme` is required by the type but ignored when `verify` is present —
    // Intercom's SHA1 X-Hub scheme is not one of the built-in SHA-256 schemes.
    scheme: "hmac-hex",
    envKey: "INTERCOM_CLIENT_SECRET",
    header: "x-hub-signature",
    verify: ({ rawBody, headers, secret }) => {
      const provided = headers["x-hub-signature"];
      if (!provided) {
        return false;
      }
      const expected = `sha1=${createHmac("sha1", secret)
        .update(rawBody)
        .digest("hex")}`;
      return safeEqual(provided.trim(), expected);
    },
  },
  schema: intercomWebhookSchema,
  async transform(payload: IntercomPayload): Promise<IngestEvent | null> {
    const event = TOPIC_EVENT_MAP[payload.topic];
    if (!event) {
      return null;
    }

    const item = payload.data.item;
    const identity = resolveIdentity(item);

    // Can't place the event on a person without an external id OR an email.
    if (!identity.externalId && !identity.email) {
      return null;
    }

    // D2 — conversation metadata → eventProperties ONLY.
    const eventProperties: Record<string, unknown> = {
      source: "intercom",
      _intercomTopic: payload.topic,
    };
    if (typeof item.id === "string") {
      eventProperties.conversationId = item.id;
    }
    if (typeof item.ai_agent_participated === "boolean") {
      eventProperties.isAiResolved = item.ai_agent_participated;
    }
    if (
      typeof item.admin_assignee_id === "string" ||
      typeof item.admin_assignee_id === "number"
    ) {
      eventProperties.assigneeId = item.admin_assignee_id;
    }
    if (
      typeof item.team_assignee_id === "string" ||
      typeof item.team_assignee_id === "number"
    ) {
      eventProperties.teamId = item.team_assignee_id;
    }
    const rating = item.conversation_rating?.rating;
    if (typeof rating === "number") {
      eventProperties.rating = rating;
    }

    // D2 — durable profile → contactProperties ONLY. Intercom's internal id is
    // a REFERENCE, never the identity key.
    const contactProperties: Record<string, unknown> = {};
    if (identity.name) {
      contactProperties.name = identity.name;
    }
    if (identity.intercomContactId) {
      contactProperties.intercomContactId = identity.intercomContactId;
    }

    return {
      event,
      // `userId` is the customer's own app user id (Intercom external_id) — the
      // same key their product/email activity uses — so this folds onto the
      // existing contact. Undefined when Intercom has no external_id (email-only).
      userId: identity.externalId,
      userEmail: identity.email,
      eventProperties,
      contactProperties,
      idempotencyKey: `intercom:${payload.id}`,
    };
  },
});
