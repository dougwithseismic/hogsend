import { WebhookVerificationError } from "@hogsend/email";
import { Webhook } from "svix";
import type {
  WebhookEvent,
  WebhookEventType,
  WebhookHandlerMap,
} from "./types.js";

export function verifyWebhook(opts: {
  payload: string;
  headers: Record<string, string>;
  signingSecret: string;
}): WebhookEvent {
  const svixId = opts.headers["svix-id"];
  const svixTimestamp = opts.headers["svix-timestamp"];
  const svixSignature = opts.headers["svix-signature"];

  if (!svixId || !svixTimestamp || !svixSignature) {
    throw new WebhookVerificationError(
      "Missing required Svix headers: svix-id, svix-timestamp, svix-signature",
    );
  }

  try {
    const wh = new Webhook(opts.signingSecret);
    const event = wh.verify(opts.payload, {
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

export function createWebhookHandler(opts: {
  signingSecret: string;
  handlers: WebhookHandlerMap;
}) {
  return async (
    payload: string,
    headers: Record<string, string>,
  ): Promise<{ type: WebhookEventType; handled: boolean }> => {
    const event = verifyWebhook({
      payload,
      headers,
      signingSecret: opts.signingSecret,
    });
    const handler = opts.handlers[event.type] as
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
