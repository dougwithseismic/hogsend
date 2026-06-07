import { z } from "zod";
import type { IngestEvent } from "../../lib/ingestion.js";
import { defineWebhookSource } from "../define-webhook-source.js";

/**
 * Stripe webhook preset.
 *
 * Auth: Stripe's `stripe-signature: t=<ts>,v1=<hex>` header, verified with
 * `node:crypto` (NO `stripe` SDK — decision #14). Set `STRIPE_WEBHOOK_SECRET`
 * (the `whsec_…` endpoint secret) to auto-enable at `POST /v1/webhooks/stripe`.
 *
 * Event mapping (decision #16, normalized to the outbound vocabulary):
 *  - `customer.created`              → `contact.created`
 *  - `customer.updated`              → `contact.updated`
 *  - `customer.deleted`             → `contact.deleted` (EVENT only — decision #15)
 *  - `customer.subscription.<action>` → `subscription.<action>`
 *  - `invoice.<action>`              → `invoice.<action>`
 *
 * Identity: `userId = obj.id` for customers, `obj.customer` for subscriptions /
 * invoices. `idempotencyKey = payload.id` (the Stripe event id) so at-least-once
 * redelivery dedupes on `user_events.idempotencyKey`.
 *
 * D2 split: customer profile (`name`, `phone`, `metadata`) → `contactProperties`
 * ONLY; everything else → `eventProperties` ONLY.
 */

const stripeObjectSchema = z
  .object({
    id: z.string().optional(),
    object: z.string().optional(),
    customer: z.string().nullish(),
    email: z.string().nullish(),
    name: z.string().nullish(),
    phone: z.string().nullish(),
    metadata: z.record(z.string(), z.unknown()).nullish(),
  })
  .catchall(z.unknown());

const stripeWebhookSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    object: z.string().optional(),
    data: z
      .object({
        object: stripeObjectSchema,
      })
      .catchall(z.unknown()),
  })
  .catchall(z.unknown());

type StripePayload = z.infer<typeof stripeWebhookSchema>;

export const stripeSource = defineWebhookSource({
  meta: {
    id: "stripe",
    name: "Stripe",
    description:
      "Receives Stripe customer/subscription/invoice webhooks (signature-verified).",
  },
  auth: {
    type: "signature",
    scheme: "stripe",
    envKey: "STRIPE_WEBHOOK_SECRET",
    header: "stripe-signature",
  },
  schema: stripeWebhookSchema,
  async transform(payload: StripePayload): Promise<IngestEvent | null> {
    const type = payload.type;
    const obj = payload.data.object;

    // Normalize the Stripe event name → Hogsend vocabulary + resolve identity.
    let event: string;
    let userId: string | undefined;
    let isCustomerLifecycle = false;
    let isDelete = false;

    if (type === "customer.created" || type === "customer.updated") {
      event =
        type === "customer.created" ? "contact.created" : "contact.updated";
      userId = obj.id;
      isCustomerLifecycle = true;
    } else if (type === "customer.deleted") {
      event = "contact.deleted";
      userId = obj.id;
      isDelete = true;
    } else if (type.startsWith("customer.subscription.")) {
      // customer.subscription.created/updated/deleted → subscription.<action>
      const action = type.slice("customer.subscription.".length);
      event = `subscription.${action}`;
      userId = typeof obj.customer === "string" ? obj.customer : undefined;
    } else if (type.startsWith("invoice.")) {
      const action = type.slice("invoice.".length);
      event = `invoice.${action}`;
      userId = typeof obj.customer === "string" ? obj.customer : undefined;
    } else {
      return null;
    }

    if (!userId) {
      return null;
    }

    const userEmail = typeof obj.email === "string" ? obj.email : "";

    const eventProperties: Record<string, unknown> = {
      source: "stripe",
      stripeCustomerId: userId,
      stripeEventId: payload.id,
      _stripeEvent: type,
      stripeObject: obj.object,
    };

    // Only the customer create/update lifecycle carries a profile to merge.
    // Deletes (decision #15) and subscription/invoice events are event-only.
    if (!isCustomerLifecycle || isDelete) {
      return {
        event,
        userId,
        userEmail,
        eventProperties,
        contactProperties: {},
        idempotencyKey: payload.id,
      };
    }

    const contactProperties: Record<string, unknown> = {
      ...(obj.metadata ?? {}),
    };
    if (typeof obj.name === "string") {
      contactProperties.name = obj.name;
    }
    if (typeof obj.phone === "string") {
      contactProperties.phone = obj.phone;
    }
    contactProperties.stripeCustomerId = userId;

    return {
      event,
      userId,
      userEmail,
      eventProperties,
      contactProperties,
      idempotencyKey: payload.id,
    };
  },
});
