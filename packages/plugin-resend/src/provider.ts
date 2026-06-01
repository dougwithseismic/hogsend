import type { RetryOptions } from "@hogsend/email";
import { createResendClient } from "./client.js";
import { sendBatchEmails, sendEmail } from "./send.js";
import type {
  BatchEmailItem,
  EmailProvider,
  SendEmailOptions,
  SendResult,
  WebhookEvent,
} from "./types.js";
import { parseWebhookEvent, verifyWebhook } from "./webhooks.js";

export interface ResendProviderConfig {
  apiKey: string;
  webhookSecret?: string;
  retryOptions?: RetryOptions;
}

/**
 * The Resend implementation of the engine's {@link EmailProvider} contract: a dumb
 * delivery + webhook parse/verify layer. All tracking, DB, preference, and
 * render logic lives in the engine's `createTrackedMailer`, not here.
 */
export function createResendProvider(
  config: ResendProviderConfig,
): EmailProvider {
  const client = createResendClient({ apiKey: config.apiKey });
  const retryOptions = config.retryOptions;

  return {
    async send(options: SendEmailOptions): Promise<SendResult> {
      return sendEmail({ client, options, retryOptions });
    },

    async sendBatch(
      emails: BatchEmailItem[],
    ): Promise<{ results: SendResult[] }> {
      const results = await sendBatchEmails({ client, emails, retryOptions });
      return { results };
    },

    verifyWebhook(opts: {
      payload: string;
      headers: Record<string, string>;
    }): WebhookEvent {
      if (!config.webhookSecret) {
        throw new Error(
          "webhookSecret is required on the provider to verify webhooks",
        );
      }
      return verifyWebhook({
        payload: opts.payload,
        headers: opts.headers,
        signingSecret: config.webhookSecret,
      });
    },

    parseWebhook(payload: string): WebhookEvent {
      return parseWebhookEvent(payload);
    },
  };
}
