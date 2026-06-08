import {
  type BatchEmailItem,
  defineEmailProvider,
  type EmailEvent,
  type EmailEventType,
  type EmailProvider,
  type SendEmailOptions,
  type SendResult,
  WebhookHandshakeSignal,
} from "@hogsend/core";
import { type Message, Models, ServerClient } from "postmark";

/**
 * Construction config for {@link createPostmarkProvider}.
 *
 * Postmark has no svix/HMAC webhook signature, so webhook authenticity is HTTP
 * Basic creds baked into the webhook URL. `webhookBasicAuth` is OPTIONAL only so
 * a send-only deploy can skip it — but `verifyWebhook` FAILS CLOSED when it is
 * unset, so an unauthenticated status update is always rejected.
 */
export interface PostmarkConfig {
  /** Postmark Server API token (per-server, not the account token). */
  serverToken: string;
  /** Outbound message stream id. Defaults to Postmark's `"outbound"`. */
  messageStream?: string;
  /** HTTP Basic creds the webhook URL must present. Unset → webhooks rejected. */
  webhookBasicAuth?: { user: string; pass: string };
}

const join = (v?: string | string[]): string | undefined =>
  v ? ([] as string[]).concat(v).join(",") : undefined;

/**
 * The Postmark implementation of the engine's {@link EmailProvider} contract: a
 * dumb delivery + webhook parse/verify layer. All tracking, DB, preference, and
 * render logic lives in the engine's `createTrackedMailer`, not here.
 *
 * Two sovereign invariants are enforced here:
 *
 * - **First-party open/click tracking is the source of truth.** Every send
 *   forces `TrackOpens: false` + `TrackLinks: "None"`, so `capabilities`
 *   declares `nativeTracking: false` and the engine trusts it.
 * - **HTML-only wire.** The engine renders React → HTML itself before calling
 *   `send`; Postmark only ever sees `HtmlBody`.
 *
 * Opt-in only — Resend stays the default. Register it explicitly via
 * `email.providers` (or the `POSTMARK_SERVER_TOKEN` env preset) and activate it
 * with `EMAIL_PROVIDER=postmark` / `email.defaultProvider: "postmark"`.
 */
export function createPostmarkProvider(cfg: PostmarkConfig): EmailProvider {
  const client = new ServerClient(cfg.serverToken);
  const stream = cfg.messageStream ?? "outbound";

  const toMessage = (o: SendEmailOptions | BatchEmailItem): Message => {
    const message: Message = {
      From: o.from,
      To: join(o.to),
      Cc: join(o.cc),
      Bcc: join(o.bcc),
      Subject: o.subject,
      // The engine ALWAYS renders React → HTML before the wire — no React here.
      HtmlBody: o.html,
      TextBody: o.text,
      ReplyTo: join(o.replyTo),
      Tag: o.tag,
      Metadata: o.metadata,
      Headers: o.headers
        ? Object.entries(o.headers).map(([Name, Value]) => ({ Name, Value }))
        : undefined,
      // NATIVE TRACKING OFF — first-party open/click tracking is sovereign.
      TrackOpens: false,
      TrackLinks: Models.LinkTrackingOptions.None,
      MessageStream: stream,
    };
    return message;
  };

  return defineEmailProvider({
    meta: { id: "postmark", name: "Postmark" },
    capabilities: {
      // Forced off per-send above → the engine TRUSTS native tracking is off.
      nativeTracking: false,
      // No native scheduled send — the engine drops `scheduledAt` with a WARN.
      scheduledSend: false,
      // No HMAC scheme — webhooks fail-closed on HTTP Basic creds instead.
      signedWebhooks: false,
    },

    async send(o: SendEmailOptions): Promise<SendResult> {
      const r = await client.sendEmail(toMessage(o));
      if (r.ErrorCode !== 0) {
        throw new Error(`Postmark ${r.ErrorCode}: ${r.Message}`);
      }
      return { id: r.MessageID } satisfies SendResult;
    },

    async sendBatch(
      items: BatchEmailItem[],
    ): Promise<{ results: SendResult[] }> {
      const r = await client.sendEmailBatch(items.map(toMessage));
      return { results: r.map((x) => ({ id: x.MessageID })) };
    },

    /**
     * Postmark has no svix/HMAC — webhook authenticity is HTTP Basic creds in
     * the webhook URL. FAIL CLOSED when creds are unconfigured or mismatched so
     * an unauthenticated status update is always rejected.
     */
    verifyWebhook(opts: {
      payload: string;
      headers: Record<string, string>;
    }): EmailEvent {
      if (!cfg.webhookBasicAuth) {
        throw new Error("Postmark webhook auth not configured");
      }
      const expected = `Basic ${Buffer.from(
        `${cfg.webhookBasicAuth.user}:${cfg.webhookBasicAuth.pass}`,
      ).toString("base64")}`;
      if (opts.headers.authorization !== expected) {
        throw new Error("Postmark webhook auth failed");
      }
      return parsePostmarkWebhook(opts.payload);
    },

    parseWebhook(payload: string): EmailEvent {
      return parsePostmarkWebhook(payload);
    },
  });
}

/**
 * Postmark `Bounce.TypeCode` values, mapped to provider-neutral bounce classes.
 * The raw string `Type` is preserved in `bounce.code` so nothing is lost.
 *
 * - `complaint` → immediate suppress via the complaint path.
 * - `transient` → recorded as `email.bounced` but does NOT suppress.
 * - `permanent` → auto-suppress (the engine increments `bounceCount`).
 *
 * @see https://postmarkapp.com/developer/api/bounce-api#bounce-types
 */
const COMPLAINT_TYPE_CODES = new Set<number>([
  512, // SpamNotification
  100001, // SpamComplaint
]);
const TRANSIENT_TYPE_CODES = new Set<number>([
  2, // Transient
  256, // DnsError
  4096, // SoftBounce
]);

/** Map a Postmark `Bounce.TypeCode` → provider-neutral bounce class. */
export function classifyPostmarkBounce(
  typeCode: number,
): "permanent" | "transient" | "complaint" {
  if (COMPLAINT_TYPE_CODES.has(typeCode)) return "complaint";
  if (TRANSIENT_TYPE_CODES.has(typeCode)) return "transient";
  // Default conservative for a delivery-status Bounce record is `permanent`
  // (HardBounce=1, BadEmailAddress=100000, Blocked=100006, …) — these are the
  // states that SHOULD auto-suppress.
  return "permanent";
}

/**
 * Adapt Postmark's verbatim webhook payload into the provider-neutral
 * {@link EmailEvent}. Maps `RecordType` → event type, `MessageID` →
 * `messageId`, `Recipient`/`Email` → `recipients`, and the `Bounce.TypeCode`
 * table → `bounce.class`. Non-delivery-status records (e.g. SubscriptionChange)
 * throw {@link WebhookHandshakeSignal} — the engine's webhook route 200s those.
 */
export function parsePostmarkWebhook(payload: string): EmailEvent {
  const p = JSON.parse(payload) as Record<string, unknown>;
  const recipients = [p.Recipient ?? p.Email].filter(
    (x): x is string => typeof x === "string" && x.length > 0,
  );
  const base = {
    messageId: (p.MessageID as string) ?? "",
    recipients,
    raw: p,
  };

  switch (p.RecordType as string) {
    case "Delivery":
      return {
        ...base,
        type: "email.delivered" as EmailEventType,
        occurredAt: (p.DeliveredAt as string) ?? new Date().toISOString(),
      };
    case "Open":
      // Only arrives if native tracking is on — we keep it off, so this is a
      // status no-op echo at most. First-party tracking owns opens.
      return {
        ...base,
        type: "email.opened" as EmailEventType,
        occurredAt: (p.ReceivedAt as string) ?? new Date().toISOString(),
      };
    case "Click":
      // Same as Open — first-party owns clicks; native echo only.
      return {
        ...base,
        type: "email.clicked" as EmailEventType,
        occurredAt: (p.ReceivedAt as string) ?? new Date().toISOString(),
        click: {
          url: (p.OriginalLink as string) ?? "",
          ...(p.ReceivedAt ? { at: p.ReceivedAt as string } : {}),
          ...(p.UserAgent ? { ua: p.UserAgent as string } : {}),
        },
      };
    case "SpamComplaint":
      return {
        ...base,
        type: "email.complained" as EmailEventType,
        occurredAt: (p.BouncedAt as string) ?? new Date().toISOString(),
        bounce: {
          class: "complaint",
          code: "SpamComplaint",
          ...(p.Description ? { reason: p.Description as string } : {}),
        },
      };
    case "Bounce": {
      const typeCode = Number(p.TypeCode ?? 0);
      const cls = classifyPostmarkBounce(typeCode);
      // Map BOTH transient + permanent → email.bounced, carrying bounce.class so
      // the ENGINE decides suppression (only `permanent` increments bounceCount;
      // `transient` is recorded but never suppresses). Do NOT map transient →
      // email.delivery_delayed (the engine no-ops that).
      return {
        ...base,
        type: (cls === "complaint"
          ? "email.complained"
          : "email.bounced") as EmailEventType,
        occurredAt: (p.BouncedAt as string) ?? new Date().toISOString(),
        bounce: {
          class: cls,
          code: (p.Type as string) ?? String(typeCode),
          ...(p.Description ? { reason: p.Description as string } : {}),
        },
      };
    }
    default:
      // SubscriptionChange and other non-delivery-status records are NOT email
      // events. Throw the typed handshake skip — the engine route 200s it.
      throw new WebhookHandshakeSignal(
        `ignored RecordType ${String(p.RecordType)}`,
      );
  }
}
