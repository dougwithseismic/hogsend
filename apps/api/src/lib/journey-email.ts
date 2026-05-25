import type { JourneyUser } from "@hogsend/core/types";
import {
  generateUnsubscribeUrl,
  JourneyNotificationEmail,
  renderToHtml,
} from "@hogsend/email";
import { createElement } from "react";
import { sendEmailTask } from "../workflows/send-email.js";

export interface JourneyEmailOptions {
  template: string;
  subject: string;
  props?: Record<string, unknown>;
}

export async function sendJourneyEmail(
  user: JourneyUser,
  options: JourneyEmailOptions,
): Promise<{ emailId: string; sentAt: string }> {
  let unsubscribeUrl: string | undefined;
  if (process.env.API_PUBLIC_URL && process.env.BETTER_AUTH_SECRET) {
    unsubscribeUrl = generateUnsubscribeUrl({
      baseUrl: process.env.API_PUBLIC_URL,
      secret: process.env.BETTER_AUTH_SECRET,
      externalId: user.id,
      email: user.email,
    });
  }

  const element = createElement(JourneyNotificationEmail, {
    name:
      (options.props?.firstName as string) ??
      (options.props?.name as string) ??
      user.email.split("@")[0] ??
      "there",
    journeyName: user.journeyId,
    eventName: options.template,
    body: options.subject,
    unsubscribeUrl,
  });
  const html = await renderToHtml(element);

  const headers: Record<string, string> = {};
  if (unsubscribeUrl) {
    headers["List-Unsubscribe"] = `<${unsubscribeUrl}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  const result = await sendEmailTask.run({
    to: user.email,
    subject: options.subject,
    html,
    tags: [
      { name: "journeyId", value: user.journeyId },
      { name: "templateKey", value: options.template },
      { name: "userId", value: user.id },
    ],
    headers,
  });

  return { emailId: result.emailId, sentAt: new Date().toISOString() };
}
