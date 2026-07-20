/**
 * `lead.submitted` — the canonical lead-capture event
 * (recipe: docs/lead-intake.md).
 *
 * Hogsend deliberately does NOT ship a form engine: any form vendor
 * (Heyflow, Perspective, Framer, Webflow, custom) that can POST a webhook
 * becomes a lead source through `defineWebhookSource` + this builder. The
 * builder normalizes a vendor payload into the ingest-event shape:
 *
 * - hidden attribution fields (planted by `@hogsend/js`
 *   `getAttributionFields()`) are split out: `hs_anonymous_id` becomes the
 *   `anonymousId` identity key (stitching the lead to the browser session and
 *   its `campaign.arrived` touchpoints), click IDs + `utm_*` ride as flat
 *   event properties under the same names `campaign.arrived` uses;
 * - form answers ride as flat event properties (identity-grade attribution
 *   keys win a name collision);
 * - contact identity/profile fields go to `contactProperties` (the D2 split);
 * - an optional estimated deal `value`/`currency` rides first-class.
 */

import { CLICK_ID_PARAM_NAMES } from "./attribution/click-ids.js";

export const LEAD_SUBMITTED = "lead.submitted" as const;

/** Hidden-field names `@hogsend/js` plants (besides click IDs + `utm_*`). */
const HS_ANONYMOUS_ID = "hs_anonymous_id";
const HS_LANDING_PAGE = "hs_landing_page";
const HS_CAPTURED_AT = "hs_captured_at";

export interface LeadSubmissionInput {
  /** The lead's email — the top-down identity anchor when present. */
  email?: string;
  /** Identity/profile fields → `contactProperties` (phone, name, …). */
  contact?: Record<string, unknown>;
  /**
   * The raw form field map — answers AND any hidden attribution fields
   * (`hs_anonymous_id`, click IDs, `utm_*`, `hs_landing_page`,
   * `hs_captured_at`). The builder splits them.
   */
  fields?: Record<string, unknown>;
  /** Estimated deal value (first-class on the event, not a property). */
  value?: number;
  /** ISO-4217 alpha code for `value`. */
  currency?: string;
  /** Vendor submission id — becomes the ingest idempotency key. */
  submissionId?: string;
  /** Caller-supplied event time (vendor timestamp). */
  occurredAt?: Date | string;
}

/** The ingest-event shape (structurally `@hogsend/engine`'s `IngestEvent`). */
export interface LeadSubmissionEvent {
  event: typeof LEAD_SUBMITTED;
  userEmail?: string;
  anonymousId?: string;
  eventProperties: Record<string, unknown>;
  contactProperties?: Record<string, unknown>;
  value?: number;
  currency?: string;
  idempotencyKey?: string;
  occurredAt?: Date | string;
}

function isAttributionKey(key: string): boolean {
  return (
    key === HS_ANONYMOUS_ID ||
    key === HS_LANDING_PAGE ||
    key === HS_CAPTURED_AT ||
    key.startsWith("utm_") ||
    (CLICK_ID_PARAM_NAMES as readonly string[]).includes(key)
  );
}

/**
 * Normalize a vendor form payload into the canonical `lead.submitted` ingest
 * event. Pure and vendor-agnostic — each webhook source maps its payload into
 * {@link LeadSubmissionInput} and returns this builder's result.
 */
export function buildLeadSubmission(
  input: LeadSubmissionInput,
): LeadSubmissionEvent {
  const answers: Record<string, unknown> = {};
  const attribution: Record<string, unknown> = {};
  let anonymousId: string | undefined;

  for (const [key, raw] of Object.entries(input.fields ?? {})) {
    if (raw === undefined || raw === null || raw === "") continue;
    if (key === HS_ANONYMOUS_ID) {
      if (typeof raw === "string") anonymousId = raw;
      continue;
    }
    if (isAttributionKey(key)) {
      // Rename the hs_-prefixed context fields to the `campaign.arrived`
      // property names so touchpoint queries see ONE vocabulary.
      if (key === HS_LANDING_PAGE) attribution.landing_page = raw;
      else if (key === HS_CAPTURED_AT)
        attribution.attribution_captured_at = raw;
      else attribution[key] = raw;
      continue;
    }
    answers[key] = raw;
  }

  return {
    event: LEAD_SUBMITTED,
    ...(input.email ? { userEmail: input.email } : {}),
    ...(anonymousId ? { anonymousId } : {}),
    // Attribution keys win a name collision with an answer field.
    eventProperties: { ...answers, ...attribution },
    ...(input.contact && Object.keys(input.contact).length > 0
      ? { contactProperties: input.contact }
      : {}),
    ...(input.value !== undefined ? { value: input.value } : {}),
    ...(input.currency ? { currency: input.currency } : {}),
    ...(input.submissionId
      ? { idempotencyKey: `lead-submitted:${input.submissionId}` }
      : {}),
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
  };
}
