import { generateUnsubscribeUrl } from "@hogsend/email";
import type {
  EmailService,
  EmailServiceSendOptions,
} from "./email-service-types.js";

let _service: EmailService | null = null;

export function setEmailService(service: EmailService): void {
  _service = service;
}

/**
 * The injected {@link EmailService} (set by `createHogsendClient` →
 * `setEmailService`). Exposed so module-level task-execution sites with no
 * client reference (the `send-email` Hatchet task, the alerting task) deliver
 * through the same provider-backed mailer the container built, honoring a
 * swapped provider instead of constructing a raw Resend client of their own.
 * Throws if read before the container has installed the service — same
 * guarantee as the journey/bucket registry singletons (the container always
 * runs first in both the API and worker processes).
 */
export function getEmailService(): EmailService {
  if (!_service) {
    throw new Error(
      "Email service not initialized. Call setEmailService() at startup.",
    );
  }
  return _service;
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

  // `sendEmail` is the loose, runtime-string entry point used by journeys: the
  // template key and props are resolved at runtime, so we build the options
  // untyped and hand them to the typed `service.send`. Type-safe call sites use
  // `container.emailService.send({ template, props })` directly.
  const sendOptions = {
    template: opts.template,
    props: {
      ...opts.props,
      name:
        (opts.props?.firstName as string) ??
        (opts.props?.name as string) ??
        opts.to.split("@")[0] ??
        "there",
      journeyName: opts.journeyName ?? opts.template,
      eventName: opts.template,
      body: opts.subject,
      unsubscribeUrl,
    },
    to: opts.to,
    subject: opts.subject,
    journeyStateId: opts.journeyStateId,
    userId: opts.userId,
    userEmail: opts.to,
    category: "journey",
    tags: [
      { name: "journeyId", value: opts.journeyName ?? opts.template },
      { name: "templateKey", value: opts.template },
      { name: "userId", value: opts.userId },
    ],
    headers,
  } as unknown as EmailServiceSendOptions;

  const result = await service.send(sendOptions);

  return {
    emailSendId: result.emailSendId,
    sentAt: new Date().toISOString(),
  };
}
