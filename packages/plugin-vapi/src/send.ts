import { VoiceCallError } from "@hogsend/voice";
import { toVapiAssistant } from "./agent-mapping.js";
import type { VapiClient } from "./client.js";
import type { StartCallOptions, VoiceStartResult } from "./types.js";

export interface VapiRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_RETRY: Required<VapiRetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
};

function isRetryableHttpStatus(status: number): boolean {
  // `POST /call` is NON-IDEMPOTENT — a 5xx or a network fault is AMBIGUOUS (Vapi
  // may already have placed the call), so retrying risks a DOUBLE-DIAL. Only a
  // 429 is safe to retry: the call was rejected by the rate limiter BEFORE being
  // placed. Everything else (4xx permanent, 5xx/network ambiguous) is surfaced
  // to the engine, which decides whether to re-drive under the idempotency key.
  return status === 429;
}

function classifyError(error: unknown): VoiceCallError {
  if (error instanceof VoiceCallError) return error;

  const message =
    error instanceof Error ? error.message : "Unknown Vapi call error";
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status: unknown }).status)
      : undefined;

  if (status !== undefined) {
    return new VoiceCallError(message, {
      retryable: isRetryableHttpStatus(status),
      statusCode: status,
      cause: error,
    });
  }

  // A network fault (no HTTP status) is ambiguous for a non-idempotent create —
  // NOT retryable. Rate-limit text with no status is the one safe exception.
  const retryable = message.toLowerCase().includes("rate limit");
  return new VoiceCallError(message, { retryable, cause: error });
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
  options: Required<VapiRetryOptions>,
): Promise<T> {
  let lastError: VoiceCallError | undefined;
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
  throw (
    lastError ?? new VoiceCallError("Retry exhausted", { retryable: false })
  );
}

/**
 * Place one outbound call via Vapi. The engine has already synthesized the
 * neutral {@link StartCallOptions.agent}; this maps it to a Vapi transient
 * assistant and POSTs `/call` with the callee + phone-number id + dynamic
 * variable values + metadata.
 */
export async function startCall(args: {
  client: VapiClient;
  options: StartCallOptions;
  phoneNumberId: string;
  server?: { url: string; secret?: string };
  retryOptions?: VapiRetryOptions;
}): Promise<VoiceStartResult> {
  const { client, options, phoneNumberId, server } = args;
  const opts = { ...DEFAULT_RETRY, ...args.retryOptions };

  const body = {
    phoneNumberId,
    customer: { number: options.to },
    assistant: toVapiAssistant(options.agent, server),
    ...(options.variables && Object.keys(options.variables).length
      ? { assistantOverrides: { variableValues: options.variables } }
      : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };

  return withRetry(async () => {
    const res = await client.createCall(body);
    return { id: res.id, ...(res.status ? { status: res.status } : {}) };
  }, opts);
}
