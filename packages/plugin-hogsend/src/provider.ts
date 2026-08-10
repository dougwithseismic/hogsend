import { createHash } from "node:crypto";
import {
  type BatchEmailItem,
  defineEmailProvider,
  type EmailEvent,
  type EmailProvider,
  normalizeRecipients,
  type SendEmailOptions,
  type SendResult,
} from "@hogsend/core";
import {
  HogsendRelayBatchError,
  type HogsendRelayBatchFailure,
  type HogsendRelayBatchResult,
  HogsendRelayError,
  HogsendRelayPausedError,
} from "./errors.js";
import {
  HOGSEND_RELAY_SIGNATURE_HEADER,
  parseHogsendRelayWebhook,
  verifyHogsendRelaySignature,
} from "./webhook.js";

/** The HTTP header the relay reads the replay-stable send key from. */
export const HOGSEND_IDEMPOTENCY_HEADER = "idempotency-key";

const SEND_PATH = "/api/email/send";
const BATCH_PATH = "/api/email/send-batch";

const SCHEDULED_SEND_WARNING =
  "Hogsend Email has no scheduled send, so `scheduledAt` was ignored and the " +
  "message was sent immediately. Use `ctx.sleepUntil(at)` instead — it is " +
  "durable, visible in the journey, and cancellable.";

/**
 * Construction config for {@link createHogsendEmailProvider}.
 *
 * `relayUrl` and `tenantToken` are plain config, deliberately. Hogsend Email is
 * Cloud-only by POLICY, not by a hard check (DECISIONS §1): nothing here asserts
 * a Cloud-shaped token, and nothing here knows about AWS.
 */
export interface HogsendEmailConfig {
  /** Origin of the Hogsend Cloud control plane, e.g. `https://cloud.hogsend.com`. */
  relayUrl: string;
  /** The environment's relay token (`hsrel_…`). The ONLY credential an instance holds. */
  tenantToken: string;
  /** HMAC secret for status webhooks. Unset ⇒ every webhook is REJECTED. */
  webhookSecret?: string;
  /** Override fetch (tests). */
  fetch?: typeof fetch;
  /** Override the sink for the one-shot capability warning (tests). */
  logger?: { warn: (message: string) => void };
}

/** The relay's strict message body. Every field is built, never spread. */
interface RelayMessage {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  tags?: Array<{ name: string; value: string }>;
}

/** Omit an empty recipient list rather than sending `[]`. */
function list(v?: string | string[]): string[] | undefined {
  const values = normalizeRecipients(v);
  return values.length > 0 ? values : undefined;
}

/**
 * Split the transport's idempotency key out of the message headers.
 *
 * The engine has no `idempotencyKey` field on `SendEmailOptions`, so the key
 * arrives as a header — and it must NOT stay one: an `Idempotency-Key` left in
 * `message.headers` would be delivered as an SMTP header on the customer's mail.
 */
function takeIdempotencyKey(headers?: Record<string, string>): {
  key?: string;
  rest?: Record<string, string>;
} {
  if (!headers) return {};
  const rest: Record<string, string> = {};
  let key: string | undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === HOGSEND_IDEMPOTENCY_HEADER) {
      key = value;
      continue;
    }
    rest[name] = value;
  }
  return {
    ...(key ? { key } : {}),
    ...(Object.keys(rest).length > 0 ? { rest } : {}),
  };
}

/**
 * The fallback key, derived from the message's own bytes.
 *
 * The relay REQUIRES an `Idempotency-Key` and answers `400
 * missing_idempotency_key` without one, so "the caller supplied none" cannot
 * mean "send none". A random key would satisfy the relay and defeat it — a
 * retry would mint a new one and send twice. A content hash is replay-stable by
 * construction: the same message re-driven after a worker crash produces the
 * same key and the relay returns the original id instead of sending again.
 */
function derivedIdempotencyKey(message: RelayMessage): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(message), "utf8")
    .digest("hex");
  return `hs_auto_${digest}`;
}

function toRelayMessage(options: SendEmailOptions | BatchEmailItem): {
  message: RelayMessage;
  idempotencyKey: string;
  /** `true` when the key was derived here rather than supplied by the caller. */
  derived: boolean;
} {
  const { key, rest } = takeIdempotencyKey(options.headers);
  // CONSTRUCTED field by field, never spread. That is what makes the HTML-only
  // wire structural rather than a convention: a `react` (or `template`, or
  // `scheduledAt`) property on the options object has no path onto the wire.
  const message: RelayMessage = {
    from: options.from,
    to: normalizeRecipients(options.to),
    subject: options.subject,
    // The engine ALWAYS renders React → HTML before the wire.
    html: options.html,
    ...(options.text !== undefined ? { text: options.text } : {}),
    ...(list(options.cc) ? { cc: list(options.cc) } : {}),
    ...(list(options.bcc) ? { bcc: list(options.bcc) } : {}),
    ...(list(options.replyTo) ? { replyTo: list(options.replyTo) } : {}),
    ...(rest ? { headers: rest } : {}),
    ...(options.tags?.length ? { tags: options.tags } : {}),
  };

  // A caller's key travels VERBATIM. Truncating it to the relay's 255-character
  // cap would be the one failure worse than the relay's own loud 400: two long
  // distinct keys could truncate to the same string, and the relay would treat
  // the second message as a replay of the first and silently never send it.
  return {
    message,
    idempotencyKey: key ?? derivedIdempotencyKey(message),
    derived: key === undefined,
  };
}

function retryAfter(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds : null;
}

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object"
    ? (body as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Turn a non-2xx relay answer into a typed error, with its shape intact.
 *
 * NOTHING is retried here, ever — not the 429, not the 503. Retry policy
 * belongs to the durable task layer that can see the whole journey; a wire that
 * quietly retried would double the load on an already-throttled relay and hide
 * a paused tenant behind a timeout.
 */
function relayError(
  response: Response,
  body: unknown,
  fallbackMessage: string,
): HogsendRelayError {
  const record = asRecord(body);
  const init = {
    status: response.status,
    error: str(record.error) ?? undefined,
    message: str(record.message) ?? fallbackMessage,
    body,
    retryAfterSeconds: retryAfter(response),
  };

  if (response.status === 403 && record.error === "tenant_paused") {
    return new HogsendRelayPausedError({
      ...init,
      reason: str(record.reason),
      pausedAt: str(record.pausedAt),
    });
  }
  return new HogsendRelayError(init);
}

/**
 * The Hogsend Email implementation of the engine's {@link EmailProvider}
 * contract: a dumb wire from an engine send to the Cloud send relay.
 *
 * It renders nothing, tracks nothing, checks no preferences, and writes no
 * `email_sends` row — the engine's `createTrackedMailer` owns all of that. Two
 * sovereign invariants hold here:
 *
 * - **HTML-only wire.** The engine renders React → HTML itself; the request
 *   body is constructed field by field, so no React value has a path onto it.
 *   The relay's own schema is strict and would refuse one regardless.
 * - **First-party tracking.** SES native open/click tracking stays off, so
 *   `capabilities.nativeTracking` is `false` and the engine trusts it.
 *
 * Opt-in only. It is an engine `optionalDependency` loaded through the guarded
 * dynamic import; nothing in the engine imports it statically, so a self-hosted
 * consumer without the package still type-checks and boots.
 */
export function createHogsendEmailProvider(
  cfg: HogsendEmailConfig,
): EmailProvider {
  const relayUrl = cfg.relayUrl.replace(/\/+$/, "");
  const fetchImpl = cfg.fetch ?? fetch;
  const logger = cfg.logger ?? console;
  let warnedScheduled = false;

  /** One relay call: auth, JSON, and the typed-error translation. */
  async function post(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<unknown> {
    const response = await fetchImpl(`${relayUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.tenantToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }

    if (!response.ok) {
      throw relayError(
        response,
        parsed,
        `Hogsend relay ${path} failed with status ${response.status}`,
      );
    }
    return parsed;
  }

  /**
   * `scheduledAt` is dropped, not honored and not failed.
   *
   * DECISIONS §3.6: SES has no scheduled send and the engine already has a
   * strictly better answer. Failing the send would punish a caller for a
   * capability flag they can read; sending it would 400 against the relay's
   * strict schema. So it is logged ONCE per provider — a 10,000-message
   * broadcast must not produce 10,000 identical warnings — and the message goes
   * out now.
   */
  function warnScheduled(scheduledAt: string | undefined): void {
    if (!scheduledAt || warnedScheduled) return;
    warnedScheduled = true;
    logger.warn(SCHEDULED_SEND_WARNING);
  }

  return defineEmailProvider({
    meta: {
      id: "hogsend",
      name: "Hogsend Email",
      description:
        "First-party sending through the Hogsend Cloud relay (AWS SES).",
    },
    capabilities: {
      // SES native tracking is never enabled — first-party open/click tracking
      // is the single source of truth.
      nativeTracking: false,
      // No scheduled send. `ctx.sleepUntil` is durable, visible, cancellable.
      scheduledSend: false,
      // The relay signs every webhook; this provider fails closed without the
      // secret.
      signedWebhooks: true,
    },
    // NO `domains` member: presence is the engine's capability gate and PRD 07
    // adds it. Absent, the domain routes report `supported: false` and every
    // other surface degrades correctly.

    async send(options: SendEmailOptions): Promise<SendResult> {
      warnScheduled(options.scheduledAt);
      const { message, idempotencyKey } = toRelayMessage(options);

      const body = await post(
        SEND_PATH,
        { message },
        { "Idempotency-Key": idempotencyKey },
      );

      const id = str(asRecord(body).id);
      if (!id) {
        throw new HogsendRelayError({
          status: 200,
          message:
            "Hogsend relay accepted the send but returned no message id.",
          body,
        });
      }
      // The relay's id, unchanged — it IS the SES message id the webhooks key
      // on, so rewriting it would break every status update.
      return { id };
    },

    async sendBatch(
      emails: BatchEmailItem[],
    ): Promise<{ results: SendResult[] }> {
      if (emails.length === 0) return { results: [] };

      // The relay refuses a batch with duplicate keys (400), and two identical
      // messages hash identically — so a DERIVED key that collides inside ONE
      // request is disambiguated by position. A caller-supplied duplicate is
      // never touched: that is a real caller bug, and the relay's 400 is the
      // right place for it to surface.
      const seen = new Set<string>();
      const items = emails.map((email, index) => {
        const { message, idempotencyKey, derived } = toRelayMessage(email);
        const key =
          derived && seen.has(idempotencyKey)
            ? `${idempotencyKey}#${index}`
            : idempotencyKey;
        seen.add(key);
        return { idempotencyKey: key, message };
      });

      const body = await post(BATCH_PATH, { items });
      const results = asRecord(body).results;
      if (!Array.isArray(results) || results.length !== items.length) {
        throw new HogsendRelayError({
          status: 200,
          message: `Hogsend relay returned ${
            Array.isArray(results) ? results.length : 0
          } results for ${items.length} batch messages.`,
          body,
        });
      }

      const entries = results as HogsendRelayBatchResult[];
      const failures: HogsendRelayBatchFailure[] = [];
      const sent: SendResult[] = [];
      for (const [index, entry] of entries.entries()) {
        if (entry?.status === "sent" && entry.id) {
          sent.push({ id: entry.id });
          continue;
        }
        failures.push({
          index,
          error: entry?.status === "failed" ? entry.error : "send_failed",
          message:
            entry?.status === "failed"
              ? entry.message
              : "The relay returned no outcome for this message.",
        });
      }

      // `SendResult` cannot express a failure, so a partial batch throws rather
      // than fabricating an id — carrying every positional outcome so nothing
      // is lost. See HogsendRelayBatchError.
      if (failures.length > 0) {
        throw new HogsendRelayBatchError({ results: entries, failures });
      }
      return { results: sent };
    },

    /**
     * FAIL CLOSED. No configured secret means every webhook is rejected and the
     * payload is never parsed — an unauthenticated status update must not be
     * able to mark a contact bounced.
     */
    verifyWebhook(opts: {
      payload: string;
      headers: Record<string, string>;
    }): EmailEvent {
      if (!cfg.webhookSecret) {
        throw new Error(
          "Hogsend relay webhook secret is not configured — webhooks are rejected.",
        );
      }

      const signature = headerValue(
        opts.headers,
        HOGSEND_RELAY_SIGNATURE_HEADER,
      );
      if (!signature) {
        throw new Error(
          `Hogsend relay webhook: missing \`${HOGSEND_RELAY_SIGNATURE_HEADER}\` signature header.`,
        );
      }
      if (
        !verifyHogsendRelaySignature({
          payload: opts.payload,
          secret: cfg.webhookSecret,
          signature,
        })
      ) {
        throw new Error(
          "Hogsend relay webhook: signature verification failed.",
        );
      }

      return parseHogsendRelayWebhook(opts.payload);
    },

    parseWebhook(payload: string): EmailEvent {
      return parseHogsendRelayWebhook(payload);
    },
  });
}

/** Header lookup that does not care how the runtime cased the name. */
function headerValue(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const direct = headers[name];
  if (direct) return direct;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}
