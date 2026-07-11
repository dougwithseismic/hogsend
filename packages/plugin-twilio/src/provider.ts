import { createTwilioClient } from "./client.js";
import { sendSms, type TwilioRetryOptions } from "./send.js";
import {
  defineSmsProvider,
  type SendSmsOptions,
  type SmsEvent,
  type SmsProvider,
  type SmsSendResult,
} from "./types.js";
import { parseWebhook, verifyWebhook } from "./webhooks.js";

export interface TwilioProviderConfig {
  accountSid: string;
  authToken: string;
  /** E.164 default sender. One of `from` / `messagingServiceSid` is required. */
  from?: string;
  /** Twilio Messaging Service SID (preferred at scale). */
  messagingServiceSid?: string;
  /**
   * Absolute status-callback URL attached to every send. The engine passes
   * `${API_PUBLIC_URL}/v1/webhooks/sms/twilio` from its env preset so delivery
   * receipts route back to the SMS webhook handler.
   */
  statusCallbackUrl?: string;
  retryOptions?: TwilioRetryOptions;
}

/**
 * The Twilio implementation of the engine's {@link SmsProvider} contract: a dumb
 * delivery + webhook parse/verify layer. All preference, suppression, DB,
 * render, and STOP-keyword logic lives in the engine's tracked SMS sender.
 */
export function createTwilioProvider(
  config: TwilioProviderConfig,
): SmsProvider {
  if (!config.from && !config.messagingServiceSid) {
    throw new Error(
      "createTwilioProvider requires a `from` number or a `messagingServiceSid`",
    );
  }

  const client = createTwilioClient({
    accountSid: config.accountSid,
    authToken: config.authToken,
  });

  return defineSmsProvider({
    meta: { id: "twilio", name: "Twilio" },
    capabilities: { signedWebhooks: true, inboundMessages: true },

    async send(options: SendSmsOptions): Promise<SmsSendResult> {
      return sendSms({
        client,
        options,
        from: config.from,
        messagingServiceSid: config.messagingServiceSid,
        statusCallback: config.statusCallbackUrl,
        retryOptions: config.retryOptions,
      });
    },

    verifyWebhook(opts: {
      payload: string;
      headers: Record<string, string>;
      url: string;
    }): SmsEvent {
      return verifyWebhook({
        payload: opts.payload,
        headers: opts.headers,
        url: opts.url,
        authToken: config.authToken,
      });
    },

    parseWebhook(payload: string): SmsEvent {
      return parseWebhook(payload);
    },
  });
}
