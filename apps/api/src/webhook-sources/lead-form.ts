import { buildLeadSubmission, defineWebhookSource } from "@hogsend/engine";
import { z } from "zod";

/**
 * Generic form-vendor lead source (docs/lead-intake.md). Point any form tool's
 * webhook (Heyflow, Perspective, Framer, Webflow, custom) at
 * `POST /v1/webhooks/lead-form` with the shared secret header. The payload is
 * a flat field map: contact fields + form answers + the hidden attribution
 * fields planted by `@hogsend/js` `getAttributionFields()` — the builder
 * splits them, stitches `hs_anonymous_id` to the browser session, and emits
 * the canonical `lead.submitted` event (optionally value-bearing).
 */

const leadFormSchema = z
  .object({
    email: z.string().email().optional(),
    phone: z.string().optional(),
    name: z.string().optional(),
    // Vendor submission id — dedups webhook retries.
    submission_id: z.string().optional(),
    // Estimated deal value (e.g. from a quote calculator step).
    value: z.number().finite().optional(),
    currency: z
      .string()
      .regex(/^[A-Za-z]{3}$/)
      .optional(),
    submitted_at: z.string().datetime().optional(),
  })
  // Everything else — answers + hidden attribution fields — passes through.
  .catchall(z.unknown());

export const leadFormSource = defineWebhookSource({
  meta: {
    id: "lead-form",
    name: "Lead form",
    description:
      "Generic form-vendor webhook (Heyflow/Perspective/custom) emitting the canonical lead.submitted event.",
  },
  auth: {
    header: "x-lead-form-secret",
    envKey: "LEAD_FORM_WEBHOOK_SECRET",
    type: "match",
  },
  schema: leadFormSchema,
  async transform(payload) {
    const {
      email,
      phone,
      name,
      submission_id: submissionId,
      value,
      currency,
      submitted_at: submittedAt,
      ...fields
    } = payload;

    if (!email && typeof fields.hs_anonymous_id !== "string") {
      // No identity key at all — nothing to attach the lead to.
      return null;
    }

    return buildLeadSubmission({
      ...(email ? { email } : {}),
      contact: {
        ...(email ? { email } : {}),
        ...(phone ? { phone } : {}),
        ...(name ? { name } : {}),
      },
      fields,
      ...(value !== undefined ? { value } : {}),
      ...(currency ? { currency } : {}),
      ...(submissionId ? { submissionId } : {}),
      ...(submittedAt ? { occurredAt: submittedAt } : {}),
    });
  },
});
