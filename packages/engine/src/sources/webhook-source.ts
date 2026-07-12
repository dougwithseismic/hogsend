import { z } from "zod";
import type { IngestEvent } from "../lib/ingestion.js";
import type { WebhookSourceAuth } from "../webhook-sources/define-webhook-source.js";
import {
  type ColdPosture,
  type ContactWriteBack,
  type DefinedContactSource,
  defineContactSource,
} from "./define-contact-source.js";

/**
 * Normalized inbound payload for the built-in GENERIC webhook contact source.
 * Anything that can POST JSON — a HubSpot/Salesforce workflow, Zapier/Make/n8n,
 * a bespoke CRM — maps its record to this shape and gets a sourced prospect with
 * no bespoke adapter. At least one of `email` / `external_id` is required (an
 * event with no resolvable key can't create a contact).
 */
export const webhookContactPayloadSchema = z
  .object({
    /** The sourcing event name (e.g. "prospect.sourced"). */
    event: z.string().min(1),
    /** The anchor identity key for a sourced lead. */
    email: z.string().email().optional(),
    /** Alternative/again identity key (a CRM record id, etc.). */
    external_id: z.string().min(1).optional(),
    anonymous_id: z.string().min(1).optional(),
    /** Enrichment → `contacts.properties` (merged additively). */
    properties: z.record(z.string(), z.unknown()).optional(),
    /** Event payload → `user_events` only. */
    event_properties: z.record(z.string(), z.unknown()).optional(),
    /** Dedup key so source retries / re-sends don't re-ingest (Layer 2). */
    idempotency_key: z.string().min(1).optional(),
    /** Caller-supplied event time (ISO-8601) for backfill/replay. */
    occurred_at: z.string().datetime().optional(),
  })
  .refine((p) => Boolean(p.email || p.external_id), {
    message: "at least one of email / external_id is required",
  });

export type WebhookContactPayload = z.infer<typeof webhookContactPayloadSchema>;

export interface WebhookContactSourceOptions {
  /** The source id — keys the registry AND the route `/v1/webhooks/:id`. */
  id: string;
  name?: string;
  description?: string;
  /** Header carrying the shared secret. Default `x-hogsend-secret`. */
  header?: string;
  /**
   * Env var holding the shared secret the header is matched against. NOTE: a
   * `match` auth is OPEN when the env value is unset — set the secret in
   * production (this source mints identified contacts).
   */
  envKey: string;
  coldPosture?: ColdPosture;
  writeBack?: ContactWriteBack;
}

/**
 * Map the normalized payload to an {@link IngestEvent}. Pure + unit-tested; the
 * `source` (provenance) is stamped by the webhook route from the source id, so
 * it is intentionally NOT set here.
 */
export function normalizeWebhookContactEvent(
  payload: WebhookContactPayload,
): IngestEvent {
  return {
    event: payload.event,
    userEmail: payload.email,
    userId: payload.external_id,
    anonymousId: payload.anonymous_id,
    eventProperties: payload.event_properties ?? {},
    contactProperties: payload.properties,
    idempotencyKey: payload.idempotency_key,
    occurredAt: payload.occurred_at,
  };
}

/**
 * Build the built-in GENERIC webhook contact source — the day-one path for any
 * CRM/tool that isn't Clay/Attio. Point its outbound webhook at
 * `POST /v1/webhooks/:id` with the shared-secret header and the normalized
 * {@link webhookContactPayloadSchema}. Auth is a shared-secret header MATCH
 * ({@link WebhookSourceAuth} `type: "match"`); the cold posture defaults to
 * email-only (see {@link defineContactSource}).
 */
export function webhookContactSource(
  opts: WebhookContactSourceOptions,
): DefinedContactSource<WebhookContactPayload> {
  const auth: WebhookSourceAuth = {
    type: "match",
    header: opts.header ?? "x-hogsend-secret",
    envKey: opts.envKey,
  };
  return defineContactSource<WebhookContactPayload>({
    meta: {
      id: opts.id,
      name: opts.name ?? "Webhook",
      description:
        opts.description ??
        "Generic webhook contact source (normalized CRM/tool payload).",
    },
    auth,
    schema: webhookContactPayloadSchema,
    coldPosture: opts.coldPosture,
    writeBack: opts.writeBack,
    transform: async (payload) => normalizeWebhookContactEvent(payload),
  });
}
