import {
  generateUnsubscribeUrl,
  JourneyNotificationEmail,
  renderToHtml,
} from "@hogsend/email";
import { createElement } from "react";
import { sendEmailTask } from "../workflows/send-email.js";

export async function sendEmail(opts: {
  to: string;
  userId: string;
  template: string;
  subject: string;
  journeyName?: string;
  props?: Record<string, unknown>;
}): Promise<{ emailId: string; sentAt: string }> {
  let unsubscribeUrl: string | undefined;
  if (process.env.API_PUBLIC_URL && process.env.BETTER_AUTH_SECRET) {
    unsubscribeUrl = generateUnsubscribeUrl({
      baseUrl: process.env.API_PUBLIC_URL,
      secret: process.env.BETTER_AUTH_SECRET,
      externalId: opts.userId,
      email: opts.to,
    });
  }

  const element = createElement(JourneyNotificationEmail, {
    name:
      (opts.props?.firstName as string) ??
      (opts.props?.name as string) ??
      opts.to.split("@")[0] ??
      "there",
    journeyName: opts.journeyName ?? opts.template,
    eventName: opts.template,
    body: opts.subject,
    unsubscribeUrl,
  });
  const html = await renderToHtml(element);

  const headers: Record<string, string> = {};
  if (unsubscribeUrl) {
    headers["List-Unsubscribe"] = `<${unsubscribeUrl}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  const result = await sendEmailTask.run({
    to: opts.to,
    subject: opts.subject,
    html,
    tags: [
      { name: "journeyId", value: opts.journeyName ?? opts.template },
      { name: "templateKey", value: opts.template },
      { name: "userId", value: opts.userId },
    ],
    headers,
  });

  return { emailId: result.emailId, sentAt: new Date().toISOString() };
}
