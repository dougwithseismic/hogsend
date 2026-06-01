import type { Database } from "@hogsend/db";
import { emailPreferences, emailSends } from "@hogsend/db";
import type {
  EmailServiceRenderOptions,
  EmailServiceRenderResult,
  TemplateName,
} from "@hogsend/email";
import { getTemplate, renderToHtml, renderToPlainText } from "@hogsend/email";
import type {
  BatchEmailItem,
  EmailProvider,
  WebhookEvent,
  WebhookEventType,
  WebhookHandlerMap,
} from "@hogsend/plugin-resend";
import { eq, sql } from "drizzle-orm";
import type {
  EmailService,
  EmailServiceConfig,
  EmailServiceSendOptions,
  EmailServiceWebhookOptions,
  EmailServiceWebhookResult,
  SendEmailOptions,
  SendResult,
  TrackedSendResult,
} from "./email-service-types.js";
import type { PrepareTrackedHtmlFn } from "./tracked.js";
import { sendTrackedEmail } from "./tracked.js";

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
          options: {
            templateKey: options.template,
            props: options.props,
            from,
            to: options.to,
            subject: options.subject,
            journeyStateId: options.journeyStateId,
            category: options.category,
            tags: options.tags,
            headers: options.headers,
            replyTo: options.replyTo,
            skipPreferenceCheck: options.skipPreferenceCheck,
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

    async sendRaw(options: SendEmailOptions): Promise<SendResult> {
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
      case "email.delivered":
      case "email.opened":
      case "email.clicked":
        await updateEmailStatus(event.type, event.data.email_id);
        break;
      case "email.bounced":
        await updateEmailStatus(event.type, event.data.email_id);
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

  async function updateEmailStatus(
    eventType: WebhookEventType,
    resendId: string,
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
        updatedAt: new Date(),
      })
      .where(eq(emailSends.resendId, resendId));
  }

  return service;
}
