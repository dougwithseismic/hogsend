import { z } from "zod";
import type { IngestEvent } from "../../lib/ingestion.js";
import { defineWebhookSource } from "../define-webhook-source.js";

/**
 * Clerk webhook preset.
 *
 * Auth: Svix-signed (`svix-id`/`svix-timestamp`/`svix-signature`). Clerk's
 * webhook signing secret is a `whsec_…` value — set `CLERK_WEBHOOK_SECRET` to
 * auto-enable this source at `POST /v1/webhooks/clerk`. Signature sources FAIL
 * CLOSED when the secret is unset.
 *
 * Event mapping (decision #16, normalized to the outbound vocabulary):
 *  - `user.created`            → `contact.created`
 *  - `user.updated`            → `contact.updated`
 *  - `user.deleted`            → `contact.deleted` (EVENT only — decision #15)
 *  - `waitlistEntry.created`   → `waitlist.joined`
 *
 * D2 split (decision, mirrors `webhook-sources/posthog.ts`): identity/profile
 * fields → `contactProperties` ONLY; behavioral/source fields → `eventProperties`
 * ONLY. The two bags are NEVER merged.
 */

const clerkEmailAddressSchema = z
  .object({
    id: z.string().optional(),
    email_address: z.string().optional(),
  })
  .catchall(z.unknown());

const clerkUserDataSchema = z
  .object({
    id: z.string().optional(),
    primary_email_address_id: z.string().nullish(),
    email_addresses: z.array(clerkEmailAddressSchema).nullish(),
    first_name: z.string().nullish(),
    last_name: z.string().nullish(),
    image_url: z.string().nullish(),
    profile_image_url: z.string().nullish(),
    public_metadata: z.record(z.string(), z.unknown()).nullish(),
  })
  .catchall(z.unknown());

const clerkWaitlistDataSchema = z
  .object({
    id: z.string().optional(),
    email_address: z.string().nullish(),
  })
  .catchall(z.unknown());

const clerkWebhookSchema = z
  .object({
    type: z.string(),
    object: z.string().optional(),
    data: z.object({}).catchall(z.unknown()).nullish(),
  })
  .catchall(z.unknown());

type ClerkPayload = z.infer<typeof clerkWebhookSchema>;

/** Resolve the primary email address from Clerk's `email_addresses` array. */
function resolveClerkEmail(
  data: z.infer<typeof clerkUserDataSchema>,
): string | undefined {
  const addresses = data.email_addresses ?? [];
  if (addresses.length === 0) {
    return undefined;
  }
  const primaryId = data.primary_email_address_id;
  if (primaryId) {
    const primary = addresses.find((a) => a.id === primaryId);
    if (primary?.email_address) {
      return primary.email_address;
    }
  }
  return addresses[0]?.email_address ?? undefined;
}

export const clerkSource = defineWebhookSource({
  meta: {
    id: "clerk",
    name: "Clerk",
    description:
      "Receives Clerk user lifecycle + waitlist webhooks (Svix-signed).",
  },
  auth: {
    type: "signature",
    scheme: "svix",
    envKey: "CLERK_WEBHOOK_SECRET",
    header: "svix-signature",
  },
  schema: clerkWebhookSchema,
  async transform(payload: ClerkPayload): Promise<IngestEvent | null> {
    const type = payload.type;

    if (type === "waitlistEntry.created") {
      const data = clerkWaitlistDataSchema.parse(payload.data ?? {});
      const userEmail =
        typeof data.email_address === "string" ? data.email_address : "";
      const userId = data.id ?? userEmail;
      if (!userId) {
        return null;
      }
      return {
        event: "waitlist.joined",
        userId,
        userEmail,
        eventProperties: {
          source: "clerk",
          _clerkEvent: type,
        },
        contactProperties: {},
      };
    }

    let event: string;
    switch (type) {
      case "user.created":
        event = "contact.created";
        break;
      case "user.updated":
        event = "contact.updated";
        break;
      case "user.deleted":
        event = "contact.deleted";
        break;
      default:
        return null;
    }

    const data = clerkUserDataSchema.parse(payload.data ?? {});
    const userId = data.id;
    if (!userId) {
      return null;
    }
    const userEmail = resolveClerkEmail(data) ?? "";

    // Deletes carry no profile to merge — emit the event only (decision #15).
    if (event === "contact.deleted") {
      return {
        event,
        userId,
        userEmail,
        eventProperties: {
          source: "clerk",
          clerkUserId: userId,
          _clerkEvent: type,
        },
        contactProperties: {},
      };
    }

    const avatarUrl =
      (typeof data.image_url === "string" ? data.image_url : undefined) ??
      (typeof data.profile_image_url === "string"
        ? data.profile_image_url
        : undefined);

    const contactProperties: Record<string, unknown> = {
      ...(data.public_metadata ?? {}),
    };
    if (typeof data.first_name === "string") {
      contactProperties.firstName = data.first_name;
    }
    if (typeof data.last_name === "string") {
      contactProperties.lastName = data.last_name;
    }
    if (avatarUrl) {
      contactProperties.avatarUrl = avatarUrl;
    }
    contactProperties.clerkUserId = userId;

    return {
      event,
      userId,
      userEmail,
      eventProperties: {
        source: "clerk",
        clerkUserId: userId,
        _clerkEvent: type,
      },
      contactProperties,
    };
  },
});
