import type { Database } from "@hogsend/db";
import { emailPreferences, emailSends } from "@hogsend/db";
import type {
  EmailServiceRenderOptions,
  EmailServiceRenderResult,
  TemplateName,
} from "@hogsend/email";
import { getTemplate, renderToHtml, renderToPlainText } from "@hogsend/email";
import { eq, sql } from "drizzle-orm";
import { createResendClient } from "./client.js";
import { sendBatchEmails, sendEmail } from "./send.js";
import type { PrepareTrackedHtmlFn } from "./tracked.js";
import { sendTrackedEmail } from "./tracked.js";
import type {
  BatchEmailItem,
  EmailService,
  EmailServiceConfig,
  EmailServiceSendOptions,
  EmailServiceWebhookOptions,
  EmailServiceWebhookResult,
  SendEmailOptions,
  SendResult,
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

export function createEmailService(
  config: EmailServiceConfig,
  deps?: { prepareTrackedHtml?: PrepareTrackedHtmlFn },
): EmailService {
  const client = createResendClient({ apiKey: config.apiKey });
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
        return sendTrackedEmail({
          db,
          client,
          retryOptions: retryDefaults,
          prepareTrackedHtml: deps?.prepareTrackedHtml,
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
      });
      const result = await sendEmail({
        client,
        options: {
          from,
          to: options.to,
          subject: options.subject ?? defaultSubject,
          react: element,
          tags: options.tags,
          headers: options.headers,
          replyTo: options.replyTo,
        },
        retryOptions: retryDefaults,
      });

      return {
        emailSendId: "",
        resendId: result.id,
        status: "sent",
      };
    },

    async sendRaw(options: SendEmailOptions): Promise<SendResult> {
      return sendEmail({
        client,
        options: { ...options, from: resolveFrom(options.from) },
        retryOptions: retryDefaults,
      });
    },

    async sendBatch(options: {
      emails: BatchEmailItem[];
    }): Promise<{ results: SendResult[] }> {
      const emails = options.emails.map((e) => ({
        ...e,
        from: resolveFrom(e.from),
      }));
      const results = await sendBatchEmails({
        client,
        emails,
        retryOptions: retryDefaults,
      });
      return { results };
    },

    async render<K extends TemplateName>(
      options: EmailServiceRenderOptions<K>,
    ): Promise<EmailServiceRenderResult> {
      const { element, subject, category } = getTemplate({
        key: options.template,
        props: options.props,
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

      const handler = createWebhookHandler({
        signingSecret: config.webhookSecret,
        handlers: {
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
            await handleBounce(event.data.to);
            await userHandlers["email.bounced"]?.(event);
          },
          "email.complained": async (event) => {
            await updateEmailStatus(event.type, event.data.email_id);
            await handleComplaint(event.data.to);
            await userHandlers["email.complained"]?.(event);
          },
          "email.delivery_delayed": async (event) => {
            await userHandlers["email.delivery_delayed"]?.(event);
          },
        },
      });

      return handler(options.payload, options.headers);
    },
  };

  const bounceThreshold = config.bounceThreshold ?? 3;

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
