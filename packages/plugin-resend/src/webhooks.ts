import type { EmailEvent, EmailEventType } from "@hogsend/core";
import { WebhookVerificationError } from "@hogsend/email";
import { Webhook } from "svix";
import type {
  WebhookEvent,
  WebhookEventType,
  WebhookHandlerMap,
} from "./types.js";

const VALID_TYPES: readonly EmailEventType[] = [
  "email.sent",
  "email.delivered",
  "email.bounced",
  "email.complained",
  "email.delivery_delayed",
  "email.opened",
  "email.clicked",
];

/**
 * Resend's `bounce.type` is a FREE STRING (no enum). Map a case-insensitive
 * substring of it to a provider-neutral {@link EmailEvent} bounce class. The raw
 * Resend string is preserved in `bounce.code` so nothing is lost.
 *
 * - `permanent` → auto-suppress (the engine increments `bounceCount`).
 * - `transient` → recorded as `email.bounced` but does NOT suppress.
 * - `complaint` → immediate suppress via the complaint path.
 * - `unknown`   → recorded, NEVER suppresses (conservative default).
 */
export function classifyResendBounce(
  type: string | undefined,
): "permanent" | "transient" | "complaint" | "unknown" {
  const t = (type ?? "").toLowerCase();
  if (!t) return "unknown";
  const has = (needle: string) => t.includes(needle.toLowerCase());

  // Complaint/spam/abuse first — a "spam complaint" must never be read as a
  // permanent bounce.
  if (has("complaint") || has("spam") || has("abuse")) return "complaint";
  if (
    has("hardbounce") ||
    has("hard_bounce") ||
    has("permanent") ||
    has("suppressedrecipient") ||
    has("suppressed")
  ) {
    return "permanent";
  }
  if (
    has("softbounce") ||
    has("soft_bounce") ||
    has("transient") ||
    has("mailboxfull") ||
    has("mailbox_full") ||
    has("throttled") ||
    has("undetermined")
  ) {
    return "transient";
  }
  return "unknown";
}

/**
 * Adapt Resend's verbatim webhook payload into the provider-neutral
 * {@link EmailEvent}. Maps `data.email_id` → `messageId`, `data.to` →
 * `recipients`, `created_at` → `occurredAt`, `data.click` → `click`, and
 * `data.bounce.{type,message}` → `bounce` (via {@link classifyResendBounce}).
 * The untouched payload is preserved in `raw` as the deprecation escape hatch.
 */
export function toEmailEvent(raw: WebhookEvent): EmailEvent {
  const occurredAt = raw.created_at ?? raw.data?.created_at ?? "";
  const recipients = Array.isArray(raw.data?.to)
    ? raw.data.to
    : raw.data?.to
      ? [raw.data.to as unknown as string]
      : [];

  const base = {
    messageId: raw.data?.email_id ?? "",
    recipients,
    occurredAt,
    raw,
  };

  switch (raw.type) {
    case "email.bounced": {
      const bounce = raw.data.bounce;
      return {
        ...base,
        type: "email.bounced",
        bounce: {
          class: classifyResendBounce(bounce?.type),
          code: bounce?.type ?? "",
          ...(bounce?.message ? { reason: bounce.message } : {}),
        },
      };
    }
    case "email.complained":
      return {
        ...base,
        type: "email.complained",
        bounce: { class: "complaint", code: "complaint" },
      };
    case "email.clicked": {
      const click = raw.data.click;
      return {
        ...base,
        type: "email.clicked",
        click: {
          url: click?.link ?? "",
          ...(click?.timestamp ? { at: click.timestamp } : {}),
          ...(click?.ipAddress ? { ip: click.ipAddress } : {}),
          ...(click?.userAgent ? { ua: click.userAgent } : {}),
        },
      };
    }
    default:
      return { ...base, type: raw.type as EmailEventType };
  }
}

/**
 * Svix-verify Resend's webhook over the EXACT received payload bytes, then adapt
 * it into the provider-neutral {@link EmailEvent}.
 */
export function verifyWebhook(opts: {
  payload: string;
  headers: Record<string, string>;
  signingSecret: string;
}): EmailEvent {
  const svixId = opts.headers["svix-id"];
  const svixTimestamp = opts.headers["svix-timestamp"];
  const svixSignature = opts.headers["svix-signature"];

  if (!svixId || !svixTimestamp || !svixSignature) {
    throw new WebhookVerificationError(
      "Missing required Svix headers: svix-id, svix-timestamp, svix-signature",
    );
  }

  try {
    const wh = new Webhook(opts.signingSecret);
    const event = wh.verify(opts.payload, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as WebhookEvent;

    return toEmailEvent(event);
  } catch (error) {
    throw new WebhookVerificationError(
      `Webhook verification failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

export function createWebhookHandler(opts: {
  signingSecret: string;
  handlers: WebhookHandlerMap;
}) {
  return async (
    payload: string,
    headers: Record<string, string>,
  ): Promise<{ type: EmailEventType; handled: boolean }> => {
    const event = verifyWebhook({
      payload,
      headers,
      signingSecret: opts.signingSecret,
    });
    const handler = opts.handlers[event.type] as
      | ((event: EmailEvent) => void | Promise<void>)
      | undefined;

    if (handler) {
      await handler(event);
      return { type: event.type, handled: true };
    }

    return { type: event.type, handled: false };
  };
}

/** Parse an unsigned Resend payload into the neutral {@link EmailEvent}. */
export function parseWebhookEvent(payload: string): EmailEvent {
  const parsed = JSON.parse(payload) as WebhookEvent;

  if (!VALID_TYPES.includes(parsed.type as EmailEventType)) {
    throw new WebhookVerificationError(
      `Unknown webhook event type: ${parsed.type as WebhookEventType}`,
    );
  }

  return toEmailEvent(parsed);
}
