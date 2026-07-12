import { toVapiAssistant } from "./agent-mapping.js";
import { createVapiClient } from "./client.js";
import { startCall, type VapiRetryOptions } from "./send.js";
import {
  defineVoiceProvider,
  type StartCallOptions,
  type VoiceAgentConfig,
  type VoiceProvider,
  type VoiceStartResult,
  type VoiceToolResult,
  type VoiceWebhookParsed,
} from "./types.js";
import { encodeToolResults, parseWebhook, verifyWebhook } from "./webhooks.js";

export interface VapiProviderConfig {
  /** Vapi private API key. */
  apiKey: string;
  /**
   * The Vapi phone-number id to place outbound calls from (bought or imported
   * Twilio number). Required for outbound telephony.
   */
  phoneNumberId: string;
  /**
   * The public webhook URL Vapi should POST status/end-of-call/tool-call events
   * to — `${API_PUBLIC_URL}/v1/webhooks/voice/vapi`. Set on each transient
   * assistant's `server.url` so events route back to the engine.
   */
  serverUrl?: string;
  /**
   * Shared secret echoed in the `X-Vapi-Secret` header on every webhook. When
   * set, webhooks are verified fail-closed; also attached to the assistant's
   * `server.secret`.
   */
  webhookSecret?: string;
  /** Override the Vapi REST base URL (tests / self-hosted proxy). */
  baseUrl?: string;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
  retryOptions?: VapiRetryOptions;
}

/**
 * The Vapi implementation of the engine's {@link VoiceProvider} contract: a dumb
 * call-placement + webhook parse/verify layer. All consent, DNC, calling-hours,
 * DB, agent-synthesis, and tool-dispatch logic lives in the engine's tracked
 * voice sender + tool dispatcher — never here.
 */
export function createVapiProvider(config: VapiProviderConfig): VoiceProvider {
  if (!config.apiKey) {
    throw new Error("createVapiProvider requires an `apiKey`");
  }
  if (!config.phoneNumberId) {
    throw new Error(
      "createVapiProvider requires a `phoneNumberId` for outbound calls",
    );
  }

  const client = createVapiClient({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
  });

  const server = config.serverUrl
    ? {
        url: config.serverUrl,
        ...(config.webhookSecret ? { secret: config.webhookSecret } : {}),
      }
    : undefined;

  return defineVoiceProvider({
    meta: { id: "vapi", name: "Vapi" },
    capabilities: {
      outboundCalls: true,
      inboundCalls: true,
      signedWebhooks: Boolean(config.webhookSecret),
      midCallTools: true,
      structuredExtraction: true,
      recording: true,
      warmTransfer: true,
    },

    async startCall(options: StartCallOptions): Promise<VoiceStartResult> {
      return startCall({
        client,
        options,
        phoneNumberId: config.phoneNumberId,
        ...(server ? { server } : {}),
        ...(config.retryOptions ? { retryOptions: config.retryOptions } : {}),
      });
    },

    verifyWebhook(opts: {
      payload: string;
      headers: Record<string, string>;
      url: string;
    }): VoiceWebhookParsed {
      return verifyWebhook({
        payload: opts.payload,
        headers: opts.headers,
        url: opts.url,
        // Undefined (not "") when unset — the verifier then ACCEPTS the payload
        // instead of 401ing a basic VAPI_API_KEY-only deploy.
        ...(config.webhookSecret ? { secret: config.webhookSecret } : {}),
      });
    },

    parseWebhook(payload: string): VoiceWebhookParsed {
      return parseWebhook(payload);
    },

    encodeToolResults(results: VoiceToolResult[]): unknown {
      return encodeToolResults(results);
    },

    encodeAssistantResponse(config: VoiceAgentConfig | null): unknown {
      // Inbound assistant-request reply — Vapi expects `{ assistant: {...} }` (or
      // an error/hangup when we decline). The transient assistant carries the
      // same server (url + secret) as outbound so its tool-calls route back.
      if (!config) return { error: "No assistant available for this number" };
      return { assistant: toVapiAssistant(config, server) };
    },
  });
}
