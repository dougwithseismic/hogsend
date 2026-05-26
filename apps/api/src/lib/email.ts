import { generateUnsubscribeUrl, type TemplateName } from "@hogsend/email";
import type { EmailService } from "@hogsend/plugin-resend";
import { createEmailService } from "@hogsend/plugin-resend";
import { getDb } from "./db.js";
import { prepareTrackedHtml } from "./tracking.js";

let _emailService: EmailService | undefined;

function getEmailService(): EmailService {
  if (!_emailService) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error("RESEND_API_KEY is required");

    _emailService = createEmailService(
      {
        apiKey,
        defaultFrom:
          process.env.RESEND_FROM_EMAIL ?? "Hogsend <noreply@hogsend.com>",
        db: getDb(),
        webhookSecret: process.env.RESEND_WEBHOOK_SECRET,
        baseUrl: process.env.API_PUBLIC_URL ?? "http://localhost:3002",
      },
      { prepareTrackedHtml },
    );
  }
  return _emailService;
}

export interface SendEmailOptions {
  to: string;
  userId: string;
  template: string;
  subject: string;
  journeyName?: string;
  journeyStateId?: string;
  props?: Record<string, unknown>;
}

export interface SendEmailResult {
  emailSendId: string;
  sentAt: string;
}

export async function sendEmail(
  opts: SendEmailOptions,
): Promise<SendEmailResult> {
  const service = getEmailService();

  let unsubscribeUrl: string | undefined;
  if (process.env.API_PUBLIC_URL && process.env.BETTER_AUTH_SECRET) {
    unsubscribeUrl = generateUnsubscribeUrl({
      baseUrl: process.env.API_PUBLIC_URL,
      secret: process.env.BETTER_AUTH_SECRET,
      externalId: opts.userId,
      email: opts.to,
    });
  }

  const headers: Record<string, string> = {};
  if (unsubscribeUrl) {
    headers["List-Unsubscribe"] = `<${unsubscribeUrl}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  const result = await service.send({
    template: opts.template as TemplateName,
    props: {
      name:
        (opts.props?.firstName as string) ??
        (opts.props?.name as string) ??
        opts.to.split("@")[0] ??
        "there",
      journeyName: opts.journeyName ?? opts.template,
      eventName: opts.template,
      body: opts.subject,
      unsubscribeUrl,
      ...opts.props,
    },
    to: opts.to,
    subject: opts.subject,
    journeyStateId: opts.journeyStateId,
    category: "journey",
    tags: [
      { name: "journeyId", value: opts.journeyName ?? opts.template },
      { name: "templateKey", value: opts.template },
      { name: "userId", value: opts.userId },
    ],
    headers,
  });

  return {
    emailSendId: result.emailSendId,
    sentAt: new Date().toISOString(),
  };
}
