import { randomUUID } from "node:crypto";
import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import {
  type Database,
  webhookDeliveries,
  webhookEndpoints,
} from "@hogsend/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { deliverWebhookTask } from "../workflows/deliver-webhook.js";
import type { SerializedContact } from "./contacts.js";
import type { Logger } from "./logger.js";
import {
  WEBHOOK_EVENT_TYPES,
  type WebhookEventType,
} from "./webhook-signing.js";

export {
  type EmailSendContextByMessageId,
  /**
   * @deprecated Kept for one minor; use {@link EmailSendContextByMessageId}.
   */
  type ResendEmailSendContext,
  resolveEmailSendContextByMessageId,
  /**
   * @deprecated Kept for one minor; use
   * {@link resolveEmailSendContextByMessageId}.
   */
  resolveEmailSendContextByResendId,
} from "./tracking-events.js";

/**
 * The outbound event catalog re-exported for the emit spine. Identical to the
 * signing lib's {@link WEBHOOK_EVENT_TYPES} — the single source of truth.
 */
export const OUTBOUND_EVENTS = WEBHOOK_EVENT_TYPES;
export type OutboundEventName = WebhookEventType;

interface EmailEventPayload {
  emailSendId: string;
  messageId: string | null;
  templateKey: string | null;
  userId: string | null;
  to: string;
  at: string;
  // Optional enrichment (additive — older subscribers ignore absent keys).
  category?: string;
  subject?: string;
}

interface BucketEventPayload {
  bucketId: string;
  bucketName: string;
  userId: string;
  userEmail: string | null;
  transition: "entered" | "left";
  entryCount: number;
  source: string;
}

/**
 * The typed per-event payload map. `data` in each delivered envelope is exactly
 * `OutboundPayloads[E]` for the emitted event `E`. Producers (the 12 hook
 * points) construct these; subscribers receive them under `envelope.data`.
 */
export interface OutboundPayloads {
  "contact.created": SerializedContact;
  "contact.updated": SerializedContact;
  "contact.deleted": {
    id: string;
    externalId: string | null;
    email: string | null;
  };
  "contact.unsubscribed": {
    externalId: string | null;
    email: string | null;
    category: string | null;
    scope: "all" | "category";
  };
  /**
   * A genuine opt-IN (resubscribe-all or a category/channel grant) — the
   * mirror of `contact.unsubscribed`, emitted from the same preference-write
   * choke. `source` is the grant provenance: `"api"` (default),
   * `"preference_center"`, `"started_keyword"`, `"import"`.
   */
  "contact.subscribed": {
    externalId: string | null;
    email: string | null;
    category: string | null;
    scope: "all" | "category";
    source: string;
  };
  "email.sent": {
    emailSendId: string;
    messageId: string;
    templateKey: string | null;
    to: string;
    userId: string | null;
    category: string | null;
    journeyStateId: string | null;
    subject: string;
    sentAt: string;
  };
  "email.delivered": EmailEventPayload;
  "email.opened": EmailEventPayload;
  "email.clicked": EmailEventPayload & { linkUrl?: string; linkId?: string };
  /**
   * A NON-email tracked link was clicked (Discord/referral/ad-hoc
   * `createTrackedLink`). The deliberate counterpart to `email.clicked` — a
   * non-email click has no `email_sends` row, so it carries `emailSendId: null`
   * and `messageId: null` and never masquerades as an email click
   * (MF-missing #3). `userId` is the link's stitch subject (`distinct_id`) when
   * the link is identity-bearing, else null for a broadcast link.
   */
  "link.clicked": {
    linkId: string;
    source: string | null;
    userId: string | null;
    emailSendId: null;
    messageId: null;
    linkUrl: string;
    at: string;
  };
  /**
   * A visitor CONFIRMED landing from a tracked hit (opt-in `hs_ref` +
   * POST /v1/t/arrive). Subset of `link.clicked` — fires only when the link
   * opts in AND the landing page reports back. Unlike `link.clicked`, `linkId`
   * here is the MANAGED `links.id` (`trackedLinkId` rides separately — no
   * legacy split), and the identity fields are the VISITOR's: `userId` only
   * when token-verified, `anonymousId` for a clamped anon arrival.
   */
  "link.arrived": {
    linkId: string;
    trackedLinkId: string;
    ref: string;
    source: string | null;
    campaign: string | null;
    userId: string | null;
    anonymousId: string | null;
    visitorKind: "token" | "anon";
    linkUrl: string | null;
    at: string;
  };
  /**
   * A SEMANTIC link answered — the in-email action event (consumer-named, e.g.
   * "nps.submitted"). Emitted at most once per (send, event name): first
   * answer wins, scanner bursts are suppressed. `event`/`properties` carry the
   * consumer semantics; the rest is send context.
   */
  "email.action": {
    event: string;
    properties: Record<string, unknown> | null;
    emailSendId: string;
    templateKey: string | null;
    userId: string | null;
    to: string;
    at: string;
    linkId: string;
    linkUrl: string;
  };
  "email.bounced": EmailEventPayload & {
    bounceType?: string;
    bounceReason?: string;
  };
  "email.complained": EmailEventPayload & {
    complaintType?: string;
    reason?: string;
  };
  "sms.sent": {
    smsSendId: string;
    messageId: string;
    templateKey: string | null;
    to: string;
    userId: string | null;
    category: string | null;
    journeyStateId: string | null;
    segments: number | null;
    sentAt: string;
  };
  "sms.delivered": {
    smsSendId: string;
    messageId: string;
    templateKey: string | null;
    userId: string | null;
    to: string;
    at: string;
  };
  "sms.failed": {
    smsSendId: string;
    messageId: string;
    templateKey: string | null;
    userId: string | null;
    to: string;
    at: string;
    errorCode?: string;
    errorReason?: string;
  };
  /**
   * A tracked SMS short link was clicked (first-party, PER-HIT — the SMS
   * sibling of `email.clicked`). `linkId` is the `tracked_links.id`,
   * `linkUrl` the original destination. `userId` is null for a raw send with
   * no resolvable contact.
   */
  "sms.clicked": {
    smsSendId: string;
    messageId: string | null;
    templateKey: string | null;
    userId: string | null;
    to: string;
    at: string;
    linkUrl: string;
    linkId: string;
  };
  "journey.completed": {
    journeyId: string;
    journeyName: string;
    stateId: string;
    userId: string;
    userEmail: string;
    completedAt: string;
  };
  "bucket.entered": BucketEventPayload;
  "bucket.left": BucketEventPayload & { reason?: string };
  /**
   * A CRM pipeline change landed on the spine (webhook or reconciliation
   * poll). Native identifiers — the canonical stage may be null when the
   * per-provider stage map has no entry (surfaced, never dropped).
   */
  "funnel.stage_changed": CrmDealEventPayload & {
    stageId: string;
    stageName: string | null;
    status: string | null;
  };
  /** A deal FIRST reached canonical `quoted`. Value = quote value. */
  "deal.quoted": CrmDealEventPayload;
  /** A deal FIRST reached canonical `sold`. Value = deal value. */
  "deal.sold": CrmDealEventPayload;
}

/** Shared payload for the `crm.*` outbound family. */
export interface CrmDealEventPayload {
  provider: string;
  dealId: string;
  pipelineId: string | null;
  canonicalStage: string | null;
  value: number | null;
  currency: string | null;
  userId: string | null;
  at: string;
}

/**
 * The signed envelope shape written to `webhook_deliveries.payload` and sent
 * verbatim to subscribers. `id` is the shared `Webhook-Id`; `timestamp` is the
 * logical-event time (ISO); `data` is the typed per-event payload.
 */
interface OutboundEnvelope<E extends OutboundEventName> {
  id: string;
  type: E;
  timestamp: string;
  data: OutboundPayloads[E];
}

/**
 * THE fire-and-forget emit spine. It does NOT deliver — it selects the active,
 * subscribed endpoints for `event`, inserts one `webhook_deliveries` row per
 * endpoint (all sharing ONE `webhookId` = the `Webhook-Id` header), and enqueues
 * the durable {@link deliverWebhookTask} per inserted row.
 *
 * Idempotency: when `dedupeKey` is provided, the unique
 * `(endpointId, dedupeKey)` index makes a re-emit (e.g. a Hatchet retry of the
 * producing task) a no-op via `onConflictDoNothing` — no duplicate row, no
 * second enqueue. Events without a `dedupeKey` are never deduped (NULL keys are
 * distinct in Postgres), which is correct for non-retryable emit points.
 *
 * NEVER throws to callers. Internal failures (endpoint select, insert, enqueue)
 * are logged via `logger.warn` and swallowed so a transient outbound error can
 * never fail a contact upsert / email send / journey step. Callers MUST STILL
 * wrap the call as `void emitOutbound(...).catch(logger.warn)` — the `.catch` is
 * defence-in-depth against a programming error that escapes this guard.
 *
 * Single-tenant: only endpoints with `organizationId IS NULL` are selected and
 * the delivery rows are written with `organizationId ?? null`. Multi-tenant
 * scoping is a later non-breaking change.
 */
export async function emitOutbound<E extends OutboundEventName>(opts: {
  db: Database;
  hatchet: HatchetClient;
  logger: Logger;
  event: E;
  payload: OutboundPayloads[E];
  dedupeKey?: string;
  organizationId?: string | null;
}): Promise<void> {
  const { db, logger, event, payload, dedupeKey } = opts;
  const organizationId = opts.organizationId ?? null;

  try {
    const webhookId = `msg_${randomUUID()}`;
    const timestamp = new Date();

    // (2) Active, subscribed endpoints. `event_types @> '["<event>"]'` matches
    // the jsonb array containing this event. Single-tenant: organizationId IS
    // NULL (NOT a hardcoded tenant — keeps the MT wiring non-breaking).
    const endpoints = await db
      .select({ id: webhookEndpoints.id })
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.disabled, false),
          isNull(webhookEndpoints.organizationId),
          sql`${webhookEndpoints.eventTypes} @> ${JSON.stringify([event])}::jsonb`,
        ),
      );

    if (endpoints.length === 0) return;

    // (3) The frozen envelope — signed + sent verbatim by the delivery task.
    const envelope: OutboundEnvelope<E> = {
      id: webhookId,
      type: event,
      timestamp: timestamp.toISOString(),
      data: payload,
    };

    // (4) One delivery row per endpoint, sharing the webhookId. onConflictDoNothing
    // on (endpointId, dedupeKey) is the producer-side fan-out idempotency guard.
    const inserted = await db
      .insert(webhookDeliveries)
      .values(
        endpoints.map((endpoint) => ({
          endpointId: endpoint.id,
          organizationId,
          webhookId,
          eventType: event,
          dedupeKey: dedupeKey ?? null,
          payload: envelope as unknown as Record<string, unknown>,
          status: "pending" as const,
          attemptCount: 0,
          nextRetryAt: timestamp,
        })),
      )
      .onConflictDoNothing({
        target: [webhookDeliveries.endpointId, webhookDeliveries.dedupeKey],
      })
      .returning({ id: webhookDeliveries.id });

    // (5) Enqueue the durable delivery task per freshly-inserted row,
    // fire-and-forget. A failed enqueue is recovered by the reaper (the row is
    // already `pending` with `nextRetryAt <= now`), so a broker hiccup here only
    // delays — never drops — a delivery.
    for (const row of inserted) {
      void deliverWebhookTask
        .runNoWait({ deliveryId: row.id })
        .catch((error: unknown) => {
          logger.warn("emitOutbound: deliverWebhookTask enqueue failed", {
            deliveryId: row.id,
            event,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
  } catch (error) {
    // FAIL-SAFE: never propagate an outbound error onto the producer's hot path.
    logger.warn("emitOutbound failed", {
      event,
      dedupeKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
