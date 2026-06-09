import {
  type BatchEmailItem,
  type BounceClass,
  type DnsRecord,
  type DomainStatus,
  type DomainsCapability,
  defineEmailProvider,
  type EmailEvent,
  type EmailEventType,
  type EmailProvider,
  joinRecipients,
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
  /**
   * Postmark ACCOUNT API token — NOT the server token. Postmark's Domains API
   * authenticates with `X-Postmark-Account-Token`, an account-level credential
   * the per-server token cannot substitute for. When absent, the provider OMITS
   * the `domains` capability entirely (the engine/CLI degrade gracefully:
   * `supported: false`, admin domain POSTs return 501).
   */
  accountToken?: string;
}

/** Postmark wants comma-joined recipient strings; omit the field when empty. */
const join = (v?: string | string[]): string | undefined =>
  joinRecipients(v) || undefined;

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
    // Postmark has a single `Tag` (first tag's value) + a `Metadata` record (all
    // tags as name→value). Omit each when there are no tags.
    const tags = o.tags ?? [];
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
      Tag: tags[0]?.value,
      Metadata:
        tags.length > 0
          ? Object.fromEntries(tags.map((t) => [t.name, t.value]))
          : undefined,
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

    // Sending-domain management — gated on the ACCOUNT token (the Domains API
    // does not accept the server token). Absent ⇒ no `domains` member at all,
    // so the engine's capability gate stays closed.
    ...(cfg.accountToken
      ? { domains: createPostmarkDomains({ accountToken: cfg.accountToken }) }
      : {}),
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

// ---------------------------------------------------------------------------
// Domains capability (Postmark account-token Domains API)
// ---------------------------------------------------------------------------

const DOMAINS_BASE_URL = "https://api.postmarkapp.com";

/** A domain as Postmark's `GET /domains/:id` detail reports it. */
interface PostmarkDomainDetail {
  ID?: number;
  Name?: string;
  DKIMVerified?: boolean;
  DKIMHost?: string;
  DKIMTextValue?: string;
  DKIMPendingHost?: string;
  DKIMPendingTextValue?: string;
  ReturnPathDomain?: string;
  ReturnPathDomainVerified?: boolean;
  ReturnPathDomainCNAMEValue?: string;
}

function postmarkErrorMessage(status: number, body: unknown): string {
  if (
    body &&
    typeof body === "object" &&
    "Message" in body &&
    typeof (body as { Message: unknown }).Message === "string"
  ) {
    return `Postmark domains API ${status}: ${(body as { Message: string }).Message}`;
  }
  return `Postmark domains API request failed with status ${status}`;
}

/**
 * Synthesize neutral {@link DnsRecord}s from a Postmark domain detail. Postmark
 * has no records array — DKIM (a TXT, preferring the PENDING host/value during
 * a rotation) and the Return-Path CNAME are reconstructed from the flat fields.
 */
function postmarkRecords(detail: PostmarkDomainDetail): DnsRecord[] {
  const records: DnsRecord[] = [];

  const dkimName = detail.DKIMPendingHost || detail.DKIMHost || "";
  const dkimValue = detail.DKIMPendingTextValue || detail.DKIMTextValue || "";
  if (dkimName && dkimValue) {
    records.push({
      type: "TXT",
      name: dkimName,
      value: dkimValue,
      purpose: "dkim",
      status: detail.DKIMVerified ? "verified" : "pending",
    });
  }

  if (detail.ReturnPathDomain && detail.ReturnPathDomainCNAMEValue) {
    records.push({
      type: "CNAME",
      name: detail.ReturnPathDomain,
      value: detail.ReturnPathDomainCNAMEValue,
      purpose: "return_path",
      status: detail.ReturnPathDomainVerified ? "verified" : "pending",
    });
  }

  return records;
}

function postmarkDomainStatus(detail: PostmarkDomainDetail): DomainStatus {
  return {
    domain: detail.Name ?? "",
    // Verified ONLY when both DKIM and the return path check out — Postmark has
    // no single domain-level status flag.
    state:
      detail.DKIMVerified && detail.ReturnPathDomainVerified
        ? "verified"
        : "pending",
    records: postmarkRecords(detail),
    providerId: "postmark",
    checkedAt: new Date().toISOString(),
    raw: detail,
  };
}

/**
 * The Postmark implementation of the {@link DomainsCapability} contract — a
 * dumb wire over `https://api.postmarkapp.com/domains`, authenticated with the
 * ACCOUNT token. Plain `fetch`, deliberately NOT the `postmark` SDK's account
 * client (keeps the opt-in surface minimal).
 */
function createPostmarkDomains(cfg: {
  accountToken: string;
}): DomainsCapability {
  const api = async (
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<{ ok: boolean; status: number; body: unknown }> => {
    const res = await fetch(`${DOMAINS_BASE_URL}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Accept: "application/json",
        "X-Postmark-Account-Token": cfg.accountToken,
        ...(init?.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    return { ok: res.ok, status: res.status, body };
  };

  /** Resolve a domain name → Postmark domain ID via `GET /domains`. */
  const findId = async (domain: string): Promise<number | null> => {
    const res = await api("/domains?count=500&offset=0");
    if (!res.ok) throw new Error(postmarkErrorMessage(res.status, res.body));
    const list =
      res.body && typeof res.body === "object" && "Domains" in res.body
        ? (res.body as { Domains: Array<{ ID?: number; Name?: string }> })
            .Domains
        : [];
    const match = (list ?? []).find((d) => d.Name === domain);
    return match?.ID ?? null;
  };

  /** Fetch + normalize `GET /domains/:id`. */
  const getById = async (id: number): Promise<DomainStatus> => {
    const res = await api(`/domains/${id}`);
    if (!res.ok) throw new Error(postmarkErrorMessage(res.status, res.body));
    return postmarkDomainStatus(res.body as PostmarkDomainDetail);
  };

  const get = async (domain: string): Promise<DomainStatus | null> => {
    const id = await findId(domain);
    if (id === null) return null;
    return getById(id);
  };

  return {
    async create(domain: string): Promise<DomainStatus> {
      const res = await api("/domains", {
        method: "POST",
        body: { Name: domain },
      });
      if (res.ok) {
        return postmarkDomainStatus(res.body as PostmarkDomainDetail);
      }

      // Idempotent create: a 422 "already exists" falls through to lookup.
      const message =
        res.body && typeof res.body === "object" && "Message" in res.body
          ? String((res.body as { Message: unknown }).Message)
          : "";
      if (res.status === 422 && /already exists/i.test(message)) {
        const existing = await get(domain);
        if (existing) return existing;
      }
      throw new Error(postmarkErrorMessage(res.status, res.body));
    },

    get,

    async records(domain: string): Promise<DnsRecord[]> {
      const status = await get(domain);
      return status?.records ?? [];
    },

    async verify(domain: string): Promise<DomainStatus> {
      const id = await findId(domain);
      if (id === null) {
        throw new Error(
          `domain "${domain}" is not registered with Postmark — run create first`,
        );
      }
      // Run BOTH verification passes best-effort (Postmark 422s a pass that is
      // already verified / not yet ready); the re-get below is the truth.
      await api(`/domains/${id}/verifyDkim`, { method: "PUT" });
      await api(`/domains/${id}/verifyReturnPath`, { method: "PUT" });
      return getById(id);
    },
  };
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
export function classifyPostmarkBounce(typeCode: number): BounceClass {
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
