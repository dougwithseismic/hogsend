import type {
  BatchEmailItem,
  EmailProvider,
  WebhookEvent,
  WebhookEventType,
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
import type {
  EmailService,
  EmailServiceConfig,
  EmailServiceSendOptions,
  EmailServiceWebhookOptions,
  EmailServiceWebhookResult,
  SendRawOptions,
  SendResult,
  TrackedSendResult,
} from "./email-service-types.js";
import { hatchet } from "./hatchet.js";
import { createLogger } from "./logger.js";
import { emitOutbound } from "./outbound.js";
import type { PrepareTrackedHtmlFn } from "./tracked.js";
import { sendTrackedEmail } from "./tracked.js";
import { resolveEmailSendContextByResendId } from "./tracking-events.js";

// Fallback logger for the provider-webhook outbound emit — `config.logger` is
// optional, but `emitOutbound` requires one. Mirrors the engine-lib singleton
// pattern (define-journey, preferences, tracked).
const emitLogger = createLogger(process.env.LOG_LEVEL);

const WEBHOOK_TO_STATUS_FIELD: Partial<
  Record<WebhookEventType, keyof typeof emailSends.$inferSelect>
> = {
  "email.sent": "sentAt",
  "email.delivered": "deliveredAt",
  "email.opened": "openedAt",
  "email.clicked": "clickedAt",
  "email.bounced": "bouncedAt",
  "email.complained": "complainedAt",
};

const WEBHOOK_TO_STATUS: Partial<Record<WebhookEventType, string>> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.bounced": "bounced",
  "email.complained": "complained",
};

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
      const result = await provider.send({
        from,
        to: options.to,
        subject: options.subject ?? defaultSubject,
        react: element,
        tags: options.tags,
        headers: options.headers,
        replyTo: options.replyTo,
      });

      return {
        emailSendId: "",
        resendId: result.id,
        status: "sent",
      };
    },

    async sendRaw(options: SendRawOptions): Promise<SendResult> {
      return provider.send({ ...options, from: resolveFrom(options.from) });
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
      options: EmailServiceWebhookOptions,
    ): Promise<EmailServiceWebhookResult> {
      if (!config.webhookSecret) {
        throw new Error(
          "webhookSecret is required in EmailServiceConfig to handle webhooks",
        );
      }

      const userHandlers: WebhookHandlerMap = config.webhookHandlers ?? {};

      const event = provider.verifyWebhook({
        payload: options.payload,
        headers: options.headers,
      });

      const handled = await dispatchWebhook(event, userHandlers);

      return { type: event.type, handled };
    },
  };

  const bounceThreshold = config.bounceThreshold ?? 3;

  async function dispatchWebhook(
    event: WebhookEvent,
    userHandlers: WebhookHandlerMap,
  ): Promise<boolean> {
    switch (event.type) {
      case "email.sent":
        // `email.sent` is emitted FIRST-PARTY from the tracked mailer's
        // provider-accepted branch (lib/tracked.ts) with the rich payload — the
        // provider-webhook echo only updates the DB status, it does NOT emit.
        await updateEmailStatus(event.type, event.data.email_id);
        break;
      case "email.delivered":
        await updateEmailStatus(event.type, event.data.email_id);
        // OUTBOUND `email.delivered` — the provider webhook is the SINGLE source
        // for delivered/bounced (these have no first-party signal).
        await emitProviderEmailEvent("email.delivered", event.data.email_id);
        break;
      case "email.opened":
      case "email.clicked":
        // First-party pixel/redirect is the SINGLE outbound emitter for
        // open/click (gated on the first-touch null→set UPDATE in the tracking
        // routes — risk 4). The provider-webhook echo is SUPPRESSED here: it only
        // updates the DB status, it does NOT emit outbound (no double-source).
        await updateEmailStatus(event.type, event.data.email_id);
        break;
      case "email.bounced":
        await updateEmailStatus(event.type, event.data.email_id, {
          bounceType: event.data.bounce?.type,
          bounceReason: event.data.bounce?.message,
        });
        // OUTBOUND `email.bounced` with the bounce detail.
        await emitProviderEmailEvent("email.bounced", event.data.email_id, {
          bounceType: event.data.bounce?.type,
          bounceReason: event.data.bounce?.message,
        });
        await handleBounce(event.data.to);
        break;
      case "email.complained":
        await updateEmailStatus(event.type, event.data.email_id);
        await handleComplaint(event.data.to);
        break;
      case "email.delivery_delayed":
        break;
    }

    const userHandler = userHandlers[event.type] as
      | ((e: WebhookEvent) => void | Promise<void>)
      | undefined;
    if (userHandler) {
      await userHandler(event);
      return true;
    }

    return false;
  }

  async function handleBounce(toAddresses: string[]): Promise<void> {
    if (!db) return;
    const email = toAddresses[0];
    if (!email) return;

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

  async function handleComplaint(toAddresses: string[]): Promise<void> {
    if (!db) return;
    const email = toAddresses[0];
    if (!email) return;

    await db
      .update(emailPreferences)
      .set({
        suppressed: true,
        suppressedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(emailPreferences.email, email));
  }

  /**
   * Emit the provider-funnel outbound event (`email.delivered` / `email.bounced`)
   * for a Resend `email_id`. Enriches via {@link resolveEmailSendContextByResendId}
   * (the only handle a provider webhook holds is the Resend id). Fire-and-forget:
   * a missing context (webhook racing the send-row commit) or a transient outbound
   * error is logged and swallowed — never failing the webhook handler. No
   * `dedupeKey`: the provider path is not a Hatchet-retryable producer, and the
   * shared `Webhook-Id` is the subscriber-side dedup for any provider redelivery.
   */
  function emitProviderEmailEvent(
    event: "email.delivered" | "email.bounced",
    resendId: string,
    bounce?: { bounceType?: string; bounceReason?: string },
  ): void {
    if (!db) return;
    const log = config.logger ?? emitLogger;
    const database = db;
    void resolveEmailSendContextByResendId(database, resendId)
      .then((ctx) => {
        if (!ctx) return;
        const base = {
          emailSendId: ctx.emailSendId,
          resendId,
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
          resendId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  async function updateEmailStatus(
    eventType: WebhookEventType,
    resendId: string,
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
      .where(eq(emailSends.resendId, resendId));
  }

  return service;
}
