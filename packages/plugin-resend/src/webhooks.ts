import { WebhookVerificationError } from "@hogsend/email";
import { Webhook } from "svix";
import type {
  WebhookEvent,
  WebhookEventType,
  WebhookHandlerMap,
} from "./types.js";

export interface WebhookVerifyOptions {
  signingSecret: string;
}

export function verifyWebhook(
  payload: string,
  headers: Record<string, string>,
  options: WebhookVerifyOptions,
): WebhookEvent {
  const svixId = headers["svix-id"];
  const svixTimestamp = headers["svix-timestamp"];
  const svixSignature = headers["svix-signature"];

  if (!svixId || !svixTimestamp || !svixSignature) {
    throw new WebhookVerificationError(
      "Missing required Svix headers: svix-id, svix-timestamp, svix-signature",
    );
  }

  try {
    const wh = new Webhook(options.signingSecret);
    const event = wh.verify(payload, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as WebhookEvent;

    return event;
  } catch (error) {
    throw new WebhookVerificationError(
      `Webhook verification failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

export function createWebhookHandler(
  signingSecret: string,
  handlers: WebhookHandlerMap,
) {
  return async (
    payload: string,
    headers: Record<string, string>,
  ): Promise<{ type: WebhookEventType; handled: boolean }> => {
    const event = verifyWebhook(payload, headers, { signingSecret });
    const handler = handlers[event.type] as
      | ((event: WebhookEvent) => void | Promise<void>)
      | undefined;

    if (handler) {
      await handler(event);
      return { type: event.type, handled: true };
    }

    return { type: event.type, handled: false };
  };
}

export function parseWebhookEvent(payload: string): WebhookEvent {
  const parsed = JSON.parse(payload) as WebhookEvent;

  const validTypes: WebhookEventType[] = [
    "email.sent",
    "email.delivered",
    "email.bounced",
    "email.complained",
    "email.delivery_delayed",
    "email.opened",
    "email.clicked",
  ];

  if (!validTypes.includes(parsed.type)) {
    throw new WebhookVerificationError(
      `Unknown webhook event type: ${parsed.type}`,
    );
  }

  return parsed;
}
