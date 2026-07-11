import { SmsSendError } from "@hogsend/sms";
import type { Twilio } from "twilio";
import type { SendSmsOptions, SmsSendResult } from "./types.js";

export interface TwilioRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_RETRY: Required<TwilioRetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
};

/**
 * Twilio REST error codes that are PERMANENT for this recipient — no retry, no
 * point re-billing. Invalid/unreachable/unsubscribed numbers. Everything else
 * (429/5xx, code 20429 too-many-requests) is transient.
 */
const PERMANENT_TWILIO_CODES = new Set([
  21211, // Invalid 'To' phone number
  21214, // 'To' number failed validation
  21408, // Permission to send to this region not enabled
  21610, // Recipient unsubscribed (STOP) — provider-level block
  21611, // Source number has exceeded queue size
  21614, // 'To' number is not a valid mobile number
  30003, // Unreachable destination handset
  30005, // Unknown destination handset
  30006, // Landline or unreachable carrier
]);

function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function classifyError(error: unknown): SmsSendError {
  if (error instanceof SmsSendError) return error;

  const message =
    error instanceof Error ? error.message : "Unknown SMS send error";

  // Twilio REST errors carry `.code` (Twilio error code) and `.status` (HTTP).
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? Number((error as { code: unknown }).code)
      : undefined;
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status: unknown }).status)
      : undefined;

  if (code !== undefined && PERMANENT_TWILIO_CODES.has(code)) {
    return new SmsSendError(message, {
      retryable: false,
      statusCode: status,
      cause: error,
    });
  }

  // 20429 = too many requests (Twilio) → retryable.
  if (code === 20429) {
    return new SmsSendError(message, {
      retryable: true,
      statusCode: status,
      cause: error,
    });
  }

  if (status !== undefined) {
    return new SmsSendError(message, {
      retryable: isRetryableHttpStatus(status),
      statusCode: status,
      cause: error,
    });
  }

  const lower = message.toLowerCase();
  const retryable =
    lower.includes("rate limit") ||
    lower.includes("timeout") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("network");
  return new SmsSendError(message, { retryable, cause: error });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(attempt: number, base: number, max: number): number {
  const exp = base * 2 ** attempt;
  const jitter = Math.random() * base;
  return Math.min(exp + jitter, max);
}

async function withRetry<T>(
  fn: () => Promise<T>,
  options: Required<TwilioRetryOptions>,
): Promise<T> {
  let lastError: SmsSendError | undefined;
  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = classifyError(error);
      if (!lastError.retryable || attempt === options.maxRetries)
        throw lastError;
      await sleep(backoff(attempt, options.baseDelayMs, options.maxDelayMs));
    }
  }
  throw lastError ?? new SmsSendError("Retry exhausted", { retryable: false });
}

/**
 * Send one SMS via Twilio. The engine has already rendered React → plain text,
 * so `options.body` is the final wire body. Exactly one of `from` /
 * `messagingServiceSid` is supplied by the provider.
 */
export async function sendSms(args: {
  client: Twilio;
  options: SendSmsOptions;
  from?: string;
  messagingServiceSid?: string;
  statusCallback?: string;
  retryOptions?: TwilioRetryOptions;
}): Promise<SmsSendResult> {
  const { client, options, from, messagingServiceSid, statusCallback } = args;
  const opts = { ...DEFAULT_RETRY, ...args.retryOptions };

  // Precedence: explicit per-send `options.from` > pinned `from` >
  // messagingServiceSid.
  const resolvedFrom = options.from ?? from;
  if (!resolvedFrom && !messagingServiceSid) {
    throw new SmsSendError(
      "Twilio send requires a `from` number or a `messagingServiceSid`",
      { retryable: false },
    );
  }

  return withRetry(async () => {
    const message = await client.messages.create({
      to: options.to,
      body: options.body,
      ...(resolvedFrom
        ? { from: resolvedFrom }
        : { messagingServiceSid: messagingServiceSid as string }),
      ...(statusCallback ? { statusCallback } : {}),
    });
    return { id: message.sid };
  }, opts);
}
