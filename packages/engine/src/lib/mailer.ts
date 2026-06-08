import type {
  BatchEmailItem,
  EmailEvent,
  EmailEventType,
  EmailProvider,
  WebhookHandlerMap,
} from "@hogsend/core";
import type { Database } from "@hogsend/db";
import { emailPreferences, emailSends } from "@hogsend/db";
import type {
  EmailServiceRenderOptions,
  EmailServiceRenderResult,
  TemplateName,
} from "@hogsend/email";
import { getTemplate, renderToHtml, renderToPlainText } from "@hogsend/email";
import { eq, sql } from "drizzle-orm";
import {
  type EmailService,
  type EmailServiceConfig,
  type EmailServiceSendOptions,
  type EmailServiceWebhookResult,
  type SendRawOptions,
  type SendResult,
  type TrackedSendResult,
  trackedSendResult,
} from "./email-service-types.js";
import { hatchet } from "./hatchet.js";
import { createLogger } from "./logger.js";
import { emitOutbound } from "./outbound.js";
import type { PrepareTrackedHtmlFn } from "./tracked.js";
import { sendTrackedEmail } from "./tracked.js";
import { resolveEmailSendContextByMessageId } from "./tracking-events.js";

// Fallback logger for the provider-webhook outbound emit — `config.logger` is
// optional, but `emitOutbound` requires one. Mirrors the engine-lib singleton
// pattern (define-journey, preferences, tracked).
const emitLogger = createLogger(process.env.LOG_LEVEL);

const WEBHOOK_TO_STATUS_FIELD: Partial<
  Record<EmailEventType, keyof typeof emailSends.$inferSelect>
> = {
  "email.sent": "sentAt",
  "email.delivered": "deliveredAt",
  "email.opened": "openedAt",
  "email.clicked": "clickedAt",
  "email.bounced": "bouncedAt",
  "email.complained": "complainedAt",
};

const WEBHOOK_TO_STATUS: Partial<Record<EmailEventType, string>> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.bounced": "bounced",
  "email.complained": "complained",
};

/** Max recipients we will iterate on a bounce/complaint, to avoid a fan-out
 * webhook mass-suppressing addresses. Above this we log + skip suppression. */
const MAX_SUPPRESSION_RECIPIENTS = 100;

/** First neutral tag → the provider-funnel `tag`. */
const tagsToTag = (
  tags?: Array<{ name: string; value: string }>,
): string | undefined => tags?.[0]?.value;

/** Neutral `{name,value}[]` → provider `metadata` record. */
const tagsToMetadata = (
  tags?: Array<{ name: string; value: string }>,
): Record<string, string> | undefined =>
  tags && tags.length > 0
    ? Object.fromEntries(tags.map((t) => [t.name, t.value]))
    : undefined;

/**
 * The engine-owned high-level mailer. It owns the full send pipeline —
 * render → preference/suppression check → tracked-html rewrite → `email_sends`
 * insert → `provider.send(...)` → status record — and delegates only the raw
 * provider delivery + webhook parse/verify to the injected {@link EmailProvider}.
 */
export function createTrackedMailer(
  config: EmailServiceConfig,
  deps: {
    provider: EmailProvider;
    prepareTrackedHtml?: PrepareTrackedHtmlFn;
  },
): EmailService {
  const { provider } = deps;
  const db = config.db as Database | undefined;
  const retryDefaults = config.retryOptions;
  const registry = config.templates;

  function resolveFrom(overrideFrom?: string): string {
    return overrideFrom ?? config.defaultFrom;
  }

  /**
   * Drop `scheduledAt` unless the active provider declares
   * `capabilities.scheduledSend`. A provider that can't natively schedule (e.g.
   * Postmark/SES) would silently ignore it — so the engine strips it and logs a
   * WARN pointing at the durable alternative (`ctx.sleepUntil`).
   */
  function applyScheduledAtGate<T extends { scheduledAt?: string }>(
    opts: T,
  ): T {
    if (opts.scheduledAt && provider.capabilities?.scheduledSend !== true) {
      (config.logger ?? emitLogger).warn(
        `scheduledAt ignored: provider ${
          provider.meta?.id ?? "resend"
        } has no native scheduled send; use ctx.sleepUntil`,
      );
      const { scheduledAt: _dropped, ...rest } = opts;
      return rest as T;
    }
    return opts;
  }

  const service: EmailService = {
    async send<K extends TemplateName>(
      options: EmailServiceSendOptions<K>,
    ): Promise<TrackedSendResult> {
      const from = resolveFrom(options.from);

      if (db) {
        return sendTrackedEmail({
          db,
          provider,
          registry,
          retryOptions: retryDefaults,
          prepareTrackedHtml: deps.prepareTrackedHtml,
          frequencyCap: config.frequencyCap,
          logger: config.logger,
          options: {
            templateKey: options.template,
            props: options.props,
            from,
            to: options.to,
            subject: options.subject,
            journeyStateId: options.journeyStateId,
            userId: options.userId,
            userEmail: options.userEmail,
            category: options.category,
            tags: options.tags,
            headers: options.headers,
            replyTo: options.replyTo,
            skipPreferenceCheck: options.skipPreferenceCheck,
            idempotencyKey: options.idempotencyKey,
            baseUrl: config.baseUrl,
          },
        });
      }

      const { element, subject: defaultSubject } = getTemplate({
        key: options.template,
        props: options.props,
        registry,
      });
      // HTML-ONLY wire — the engine ALWAYS renders React → HTML itself before
      // the provider. React Email stays first-class for authoring/Studio; it
      // never crosses the provider boundary.
      const html = await renderToHtml(element);
      const result = await provider.send({
        from,
        to: options.to,
        subject: options.subject ?? defaultSubject,
        html,
        ...(tagsToTag(options.tags) !== undefined
          ? { tag: tagsToTag(options.tags) }
          : {}),
        ...(tagsToMetadata(options.tags)
          ? { metadata: tagsToMetadata(options.tags) }
          : {}),
        headers: options.headers,
        replyTo: options.replyTo,
      });

      return trackedSendResult({
        emailSendId: "",
        messageId: result.id,
        status: "sent",
      });
    },

    async sendRaw(options: SendRawOptions): Promise<SendResult> {
      const gated = applyScheduledAtGate(options);
      return provider.send({ ...gated, from: resolveFrom(options.from) });
    },

    async sendBatch(options: {
      emails: BatchEmailItem[];
    }): Promise<{ results: SendResult[] }> {
      const emails = options.emails.map((e) => ({
        ...e,
        from: resolveFrom(e.from),
      }));
      return provider.sendBatch(emails);
    },

    async render<K extends TemplateName>(
      options: EmailServiceRenderOptions<K>,
    ): Promise<EmailServiceRenderResult> {
      const { element, subject, category } = getTemplate({
        key: options.template,
        props: options.props,
        registry,
      });

      const [html, text] = await Promise.all([
        renderToHtml(element),
        renderToPlainText(element),
      ]);

      return { html, text, subject, category };
    },

    async handleWebhook(
      event: EmailEvent,
      _providerId?: string,
    ): Promise<EmailServiceWebhookResult> {
      // The route owns provider resolution + signature verification and hands us
      // an already-verified, provider-neutral EmailEvent. No secret gate here —
      // each provider owns its own webhook secret at construction time.
      const userHandlers: WebhookHandlerMap = config.webhookHandlers ?? {};
      const handled = await dispatchWebhook(event, userHandlers);
      return { type: event.type, handled };
    },
  };

  const bounceThreshold = config.bounceThreshold ?? 3;

  async function dispatchWebhook(
    event: EmailEvent,
    userHandlers: WebhookHandlerMap,
  ): Promise<boolean> {
    switch (event.type) {
      case "email.sent":
        // `email.sent` is emitted FIRST-PARTY from the tracked mailer's
        // provider-accepted branch (lib/tracked.ts) with the rich payload — the
        // provider-webhook echo only updates the DB status, it does NOT emit.
        await updateEmailStatus(event.type, event.messageId);
        break;
      case "email.delivered":
        await updateEmailStatus(event.type, event.messageId);
        // OUTBOUND `email.delivered` — the provider webhook is the SINGLE source
        // for delivered/bounced (these have no first-party signal).
        await emitProviderEmailEvent("email.delivered", event.messageId);
        break;
      case "email.opened":
      case "email.clicked":
        // First-party pixel/redirect is the SINGLE outbound emitter for
        // open/click — it now fires PER-HIT (every open/click → a delivery to
        // every destination, owner decision 1). The provider-webhook echo is
        // SUPPRESSED here: it only updates the DB status, it does NOT emit
        // outbound (no double-source). This is the outbound-echo defence for a
        // provider with native tracking left ON.
        await updateEmailStatus(event.type, event.messageId);
        break;
      case "email.bounced":
        // `bounce.class` is stored in `bounceType`, the human reason in
        // `bounceReason`. Soft/transient bounces are recorded here too (status
        // `bounced`, `class:'transient'`) — the old transient →
        // `email.delivery_delayed` no-op is gone.
        await updateEmailStatus(event.type, event.messageId, {
          bounceType: event.bounce?.class,
          bounceReason: event.bounce?.reason,
        });
        // OUTBOUND `email.bounced` with the bounce detail (class + reason).
        await emitProviderEmailEvent("email.bounced", event.messageId, {
          bounceType: event.bounce?.class,
          bounceReason: event.bounce?.reason,
        });
        // Suppress (increment bounceCount toward threshold) ONLY on a permanent
        // bounce. Transient/unknown are recorded but never auto-suppress.
        if (event.bounce?.class === "permanent") {
          await handleBounce(event.recipients);
        }
        break;
      case "email.complained":
        await updateEmailStatus(event.type, event.messageId);
        // OUTBOUND `email.complained` — the provider webhook is the SINGLE
        // source for complaints (no first-party signal exists).
        await emitProviderEmailEvent("email.complained", event.messageId);
        await handleComplaint(event.recipients);
        break;
      case "email.delivery_delayed":
        // No-op: providers now map transient bounces to `email.bounced` with
        // `class:'transient'`, so soft bounces are recorded there instead.
        break;
    }

    const userHandler = userHandlers[event.type] as
      | ((e: EmailEvent) => void | Promise<void>)
      | undefined;
    if (userHandler) {
      await userHandler(event);
      return true;
    }

    return false;
  }

  /** Recipients to actually act on: de-duped, falsy-stripped, count-capped. A
   * fan-out webhook over the cap is logged + skipped to avoid mass-suppression. */
  function validRecipients(recipients: string[]): string[] {
    const unique = [...new Set(recipients.filter(Boolean))];
    if (unique.length > MAX_SUPPRESSION_RECIPIENTS) {
      (config.logger ?? emitLogger).warn(
        "suppression skipped: recipient count exceeds cap",
        { count: unique.length, cap: MAX_SUPPRESSION_RECIPIENTS },
      );
      return [];
    }
    return unique;
  }

  async function handleBounce(recipients: string[]): Promise<void> {
    if (!db) return;
    const emails = validRecipients(recipients);
    if (emails.length === 0) return;

    for (const email of emails) {
      await db
        .update(emailPreferences)
        .set({
          bounceCount: sql`${emailPreferences.bounceCount} + 1`,
          lastBounceAt: new Date(),
          suppressed: sql`CASE WHEN ${emailPreferences.bounceCount} + 1 >= ${bounceThreshold} THEN true ELSE ${emailPreferences.suppressed} END`,
          suppressedAt: sql`CASE WHEN ${emailPreferences.bounceCount} + 1 >= ${bounceThreshold} THEN NOW() ELSE ${emailPreferences.suppressedAt} END`,
          updatedAt: new Date(),
        })
        .where(eq(emailPreferences.email, email));
    }
  }

  async function handleComplaint(recipients: string[]): Promise<void> {
    if (!db) return;
    const emails = validRecipients(recipients);
    if (emails.length === 0) return;

    for (const email of emails) {
      await db
        .update(emailPreferences)
        .set({
          suppressed: true,
          suppressedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(emailPreferences.email, email));
    }
  }

  /**
   * Emit the provider-funnel outbound event (`email.delivered` /
   * `email.bounced` / `email.complained`) for a provider `messageId`. These three
   * have no first-party signal — the provider webhook is their single source.
   * Enriches via {@link resolveEmailSendContextByMessageId}
   * (the only handle a provider webhook holds is the message id). Fire-and-forget:
   * a missing context (webhook racing the send-row commit) or a transient outbound
   * error is logged and swallowed — never failing the webhook handler. No
   * `dedupeKey`: the provider path is not a Hatchet-retryable producer, and the
   * shared `Webhook-Id` is the subscriber-side dedup for any provider redelivery.
   */
  function emitProviderEmailEvent(
    event: "email.delivered" | "email.bounced" | "email.complained",
    messageId: string,
    bounce?: { bounceType?: string; bounceReason?: string },
  ): void {
    if (!db) return;
    const log = config.logger ?? emitLogger;
    const database = db;
    void resolveEmailSendContextByMessageId(database, messageId)
      .then((ctx) => {
        if (!ctx) return;
        const base = {
          emailSendId: ctx.emailSendId,
          messageId,
          templateKey: ctx.templateKey,
          userId: ctx.userId,
          to: ctx.to,
          at: new Date().toISOString(),
        };
        if (event === "email.bounced") {
          return emitOutbound({
            db: database,
            hatchet,
            logger: log,
            event: "email.bounced",
            payload: {
              ...base,
              ...(bounce?.bounceType ? { bounceType: bounce.bounceType } : {}),
              ...(bounce?.bounceReason
                ? { bounceReason: bounce.bounceReason }
                : {}),
            },
          });
        }
        if (event === "email.complained") {
          return emitOutbound({
            db: database,
            hatchet,
            logger: log,
            event: "email.complained",
            payload: base,
          });
        }
        return emitOutbound({
          db: database,
          hatchet,
          logger: log,
          event: "email.delivered",
          payload: base,
        });
      })
      .catch((err: unknown) => {
        log.warn(`emitOutbound ${event} failed`, {
          messageId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  async function updateEmailStatus(
    eventType: EmailEventType,
    messageId: string,
    extra?: { bounceType?: string; bounceReason?: string },
  ): Promise<void> {
    if (!db) return;

    const timestampField = WEBHOOK_TO_STATUS_FIELD[eventType];
    const status = WEBHOOK_TO_STATUS[eventType];
    if (!timestampField || !status) return;

    await db
      .update(emailSends)
      .set({
        status: status as typeof emailSends.$inferSelect.status,
        [timestampField]: new Date(),
        ...(extra?.bounceType ? { bounceType: extra.bounceType } : {}),
        ...(extra?.bounceReason ? { bounceReason: extra.bounceReason } : {}),
        updatedAt: new Date(),
      })
      .where(eq(emailSends.messageId, messageId));
  }

  return service;
}
