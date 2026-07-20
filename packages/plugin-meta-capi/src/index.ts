import { createHash } from "node:crypto";
import {
  type ConversionDestination,
  type ConversionDispatchInput,
  defineConversionDestination,
} from "@hogsend/core";

/**
 * Meta Conversions API destination —
 * the reference `ConversionDestination`. Sends ONE server event per fired
 * conversion with:
 *
 * - `event_id` = the engine's deterministic dedup id (stable across retries;
 *   a browser Pixel twin sharing the id dedups against it — Meta dedups on
 *   event_name + event_id);
 * - `fbc` RECONSTRUCTED as `fb.1.<click_ts_ms>.<fbclid>` from the stored
 *   click evidence — never fabricated when no real Meta click exists;
 * - SHA-256-hashed email/phone/external_id (fbc is sent plain, per spec);
 * - `action_source: "system_generated"` — the post-May-2025 home of
 *   CRM/offline events (the Offline Conversions API is retired).
 *
 * Event naming: per-definition overrides via `eventNames`, else `Purchase`
 * for valued conversions and `Lead` otherwise. For the Conversion Leads
 * performance goal, map funnel-stage definitions to the custom stage names
 * you configure in Events Manager's Leads Funnel.
 */

export interface MetaCapiConfig {
  /** The pixel (dataset) id events are sent to. */
  pixelId: string;
  /** A system-user access token with ads_management on the pixel. */
  accessToken: string;
  /** Route events to Events Manager's Test Events tab. */
  testEventCode?: string;
  /** Per-definition event names: `{ [definitionId]: "Purchase" | custom }`. */
  eventNames?: Record<string, string>;
  /** Fallback when a definition has no mapping and no value. Default "Lead". */
  defaultEventName?: string;
  /** Fallback for VALUED conversions with no mapping. Default "Purchase". */
  defaultValuedEventName?: string;
  /** Graph API version. Default "v21.0". */
  graphVersion?: string;
  /** Override the API origin (tests). */
  baseUrl?: string;
  /** Override fetch (tests). */
  fetch?: typeof fetch;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Meta normalization: email lowercase/trimmed; phone digits-only. */
export function hashEmail(email: string): string {
  return sha256(email.trim().toLowerCase());
}

/**
 * Meta wants digits-only WITH country code (E.164 minus the `+`). Store
 * phones E.164 (lead intake does); a national-format "07700900123" hashes
 * to a non-matching value — this function cannot guess the country.
 */
export function hashPhone(phone: string): string {
  return sha256(phone.replace(/[^0-9]/g, ""));
}

/** `fbc` from stored click evidence. Null when there was no real Meta click. */
export function reconstructFbc(clicks: {
  clickIds: Record<string, string>;
  clickAt?: number;
}): string | null {
  const fbclid = clicks.clickIds.fbclid;
  if (!fbclid || !clicks.clickAt) return null;
  return `fb.1.${clicks.clickAt}.${fbclid}`;
}

/** The event payload builder — exported pure for tests. */
export function buildMetaEvent(
  input: ConversionDispatchInput,
  config: Pick<
    MetaCapiConfig,
    "eventNames" | "defaultEventName" | "defaultValuedEventName"
  >,
): Record<string, unknown> {
  const eventName =
    config.eventNames?.[input.definitionId] ??
    (input.value !== null
      ? (config.defaultValuedEventName ?? "Purchase")
      : (config.defaultEventName ?? "Lead"));

  const userData: Record<string, unknown> = {};
  if (input.contact.email) userData.em = [hashEmail(input.contact.email)];
  if (input.contact.phone) userData.ph = [hashPhone(input.contact.phone)];
  if (input.contact.externalId) {
    userData.external_id = [sha256(input.contact.externalId)];
  }
  const fbc = reconstructFbc(input.clicks);
  if (fbc) userData.fbc = fbc;

  return {
    event_name: eventName,
    event_time: Math.floor(input.occurredAt / 1000),
    event_id: input.eventId,
    action_source: "system_generated",
    user_data: userData,
    custom_data: {
      ...(input.value !== null ? { value: input.value } : {}),
      ...(input.currency ? { currency: input.currency } : {}),
      trigger_event: input.triggerEvent,
      definition_id: input.definitionId,
    },
  };
}

export function createMetaCapiDestination(
  config: MetaCapiConfig,
): ConversionDestination {
  const base = (config.baseUrl ?? "https://graph.facebook.com").replace(
    /\/+$/,
    "",
  );
  const version = config.graphVersion ?? "v21.0";
  const fetchImpl = config.fetch ?? fetch;

  return defineConversionDestination({
    meta: {
      id: "meta-capi",
      name: "Meta Conversions API",
      description:
        "Valued conversion feedback to Meta (system_generated CAPI events).",
    },
    async send(input) {
      const event = buildMetaEvent(input, config);
      const res = await fetchImpl(
        `${base}/${version}/${encodeURIComponent(config.pixelId)}/events`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            data: [event],
            access_token: config.accessToken,
            ...(config.testEventCode
              ? { test_event_code: config.testEventCode }
              : {}),
          }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        events_received?: number;
        fbtrace_id?: string;
        error?: { message?: string };
      };
      if (!res.ok || body.error) {
        throw new Error(
          `Meta CAPI ${res.status}: ${body.error?.message ?? "send failed"}`,
        );
      }
      return {
        response: {
          events_received: body.events_received,
          fbtrace_id: body.fbtrace_id,
        },
      };
    },
  });
}
