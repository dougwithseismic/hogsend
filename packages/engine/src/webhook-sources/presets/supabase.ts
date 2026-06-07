import { z } from "zod";
import type { IngestEvent } from "../../lib/ingestion.js";
import { defineWebhookSource } from "../define-webhook-source.js";

/**
 * Supabase `auth.users` webhook preset.
 *
 * Auth: Svix-signed when Supabase's "Send HTTP Request" hook is configured with
 * a signing secret; falls back to the plain `x-supabase-webhook-secret` shared
 * secret (via `fallbackMatchHeader`) for the database-webhook trigger path. Set
 * `SUPABASE_WEBHOOK_SECRET` to auto-enable at `POST /v1/webhooks/supabase`.
 *
 * Only `schema === "auth" && table === "users"` rows are processed (other tables
 * are skipped). Event mapping (decision #16, normalized):
 *  - `INSERT` → `contact.created`
 *  - `UPDATE` → `contact.updated`
 *  - `DELETE` → `contact.deleted` (EVENT only — decision #15)
 *
 * D2 split: profile fields → `contactProperties` ONLY; behavioral/source fields
 * → `eventProperties` ONLY.
 */

const supabaseUserRowSchema = z
  .object({
    id: z.string().optional(),
    email: z.string().nullish(),
    phone: z.string().nullish(),
    email_confirmed_at: z.string().nullish(),
    raw_user_meta_data: z.record(z.string(), z.unknown()).nullish(),
  })
  .catchall(z.unknown());

const supabaseWebhookSchema = z
  .object({
    type: z.enum(["INSERT", "UPDATE", "DELETE"]),
    table: z.string(),
    schema: z.string(),
    record: supabaseUserRowSchema.nullish(),
    old_record: supabaseUserRowSchema.nullish(),
  })
  .catchall(z.unknown());

type SupabasePayload = z.infer<typeof supabaseWebhookSchema>;

export const supabaseSource = defineWebhookSource({
  meta: {
    id: "supabase",
    name: "Supabase",
    description:
      "Receives Supabase auth.users INSERT/UPDATE/DELETE webhooks (Svix-signed or shared-secret).",
  },
  auth: {
    type: "signature",
    scheme: "svix",
    envKey: "SUPABASE_WEBHOOK_SECRET",
    header: "svix-signature",
    fallbackMatchHeader: "x-supabase-webhook-secret",
  },
  schema: supabaseWebhookSchema,
  async transform(payload: SupabasePayload): Promise<IngestEvent | null> {
    // Only auth.users mutations map to contacts; ignore everything else.
    if (payload.schema !== "auth" || payload.table !== "users") {
      return null;
    }

    let event: string;
    switch (payload.type) {
      case "INSERT":
        event = "contact.created";
        break;
      case "UPDATE":
        event = "contact.updated";
        break;
      case "DELETE":
        event = "contact.deleted";
        break;
      default:
        return null;
    }

    // DELETE carries the row in `old_record`; INSERT/UPDATE in `record`.
    const row =
      payload.type === "DELETE"
        ? (payload.old_record ?? payload.record)
        : (payload.record ?? payload.old_record);

    if (!row) {
      return null;
    }

    const userId = row.id;
    if (!userId) {
      return null;
    }
    const userEmail = typeof row.email === "string" ? row.email : "";

    const eventProperties: Record<string, unknown> = {
      source: "supabase",
      supabaseUserId: userId,
      _supabaseEvent: payload.type,
    };

    // Deletes carry no profile to merge — emit the event only (decision #15).
    if (event === "contact.deleted") {
      return {
        event,
        userId,
        userEmail,
        eventProperties,
        contactProperties: {},
      };
    }

    const contactProperties: Record<string, unknown> = {
      ...(row.raw_user_meta_data ?? {}),
    };
    if (typeof row.phone === "string") {
      contactProperties.phone = row.phone;
    }
    contactProperties.emailVerified = Boolean(row.email_confirmed_at);
    contactProperties.supabaseUserId = userId;

    return {
      event,
      userId,
      userEmail,
      eventProperties,
      contactProperties,
    };
  },
});
