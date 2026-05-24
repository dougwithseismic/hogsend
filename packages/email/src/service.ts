import type { Database } from "@hogsend/db";
import { emailSends } from "@hogsend/db";
import { eq } from "drizzle-orm";
import { Resend } from "resend";
import { getTemplate } from "./registry.js";
import { renderToHtml, renderToPlainText } from "./render.js";
import { sendBatchEmails, sendEmail } from "./send.js";
import { sendTrackedEmail } from "./tracked.js";
import type {
  BatchEmailItem,
  EmailService,
  EmailServiceConfig,
  EmailServiceRenderOptions,
  EmailServiceRenderResult,
  EmailServiceSendOptions,
  EmailServiceWebhookOptions,
  EmailServiceWebhookResult,
  SendEmailOptions,
  SendResult,
  TemplateName,
  TrackedSendResult,
  WebhookEventType,
  WebhookHandlerMap,
} from "./types.js";
import { createWebhookHandler } from "./webhooks.js";

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

export function createEmailService(config: EmailServiceConfig): EmailService {
  const client = new Resend(config.apiKey);
  const db = config.db as Database | undefined;
  const retryDefaults = config.retryOptions;

  function resolveFrom(overrideFrom?: string): string {
    return overrideFrom ?? config.defaultFrom;
  }

  const service: EmailService = {
    async send<K extends TemplateName>(
      options: EmailServiceSendOptions<K>,
    ): Promise<TrackedSendResult> {
      const from = resolveFrom(options.from);

      if (db) {
        return sendTrackedEmail(
          { db, client, retryOptions: retryDefaults },
          {
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
          },
        );
      }

      const { element, subject: defaultSubject } = getTemplate(
        options.template,
        options.props,
      );
      const result = await sendEmail(
        client,
        {
          from,
          to: options.to,
          subject: options.subject ?? defaultSubject,
          react: element,
          tags: options.tags,
          headers: options.headers,
          replyTo: options.replyTo,
        },
        retryDefaults,
      );

      return {
        emailSendId: "",
        resendId: result.id,
        status: "sent",
      };
    },

    async sendRaw(options: SendEmailOptions): Promise<SendResult> {
      return sendEmail(
        client,
        { ...options, from: resolveFrom(options.from) },
        retryDefaults,
      );
    },

    async sendBatch(options: {
      emails: BatchEmailItem[];
    }): Promise<{ results: SendResult[] }> {
      const emails = options.emails.map((e) => ({
        ...e,
        from: resolveFrom(e.from),
      }));
      const results = await sendBatchEmails(client, emails, retryDefaults);
      return { results };
    },

    async render<K extends TemplateName>(
      options: EmailServiceRenderOptions<K>,
    ): Promise<EmailServiceRenderResult> {
      const { element, subject, category } = getTemplate(
        options.template,
        options.props,
      );

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

      const handler = createWebhookHandler(config.webhookSecret, {
        "email.sent": async (event) => {
          await updateEmailStatus(event.type, event.data.email_id);
          await userHandlers["email.sent"]?.(event);
        },
        "email.delivered": async (event) => {
          await updateEmailStatus(event.type, event.data.email_id);
          await userHandlers["email.delivered"]?.(event);
        },
        "email.opened": async (event) => {
          await updateEmailStatus(event.type, event.data.email_id);
          await userHandlers["email.opened"]?.(event);
        },
        "email.clicked": async (event) => {
          await updateEmailStatus(event.type, event.data.email_id);
          await userHandlers["email.clicked"]?.(event);
        },
        "email.bounced": async (event) => {
          await updateEmailStatus(event.type, event.data.email_id);
          await userHandlers["email.bounced"]?.(event);
        },
        "email.complained": async (event) => {
          await updateEmailStatus(event.type, event.data.email_id);
          await userHandlers["email.complained"]?.(event);
        },
        "email.delivery_delayed": async (event) => {
          await userHandlers["email.delivery_delayed"]?.(event);
        },
      });

      return handler(options.payload, options.headers);
    },
  };

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
