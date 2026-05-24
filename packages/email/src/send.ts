import type { Resend } from "resend";
import {
  type BatchEmailItem,
  DEFAULT_RETRY_OPTIONS,
  EmailSendError,
  type RetryOptions,
  type SendEmailOptions,
  type SendResult,
} from "./types.js";

const BATCH_CHUNK_SIZE = 100;

function normalizeRecipients(to: string | string[]): string[] {
  return Array.isArray(to) ? to : [to];
}

function isRetryableStatusCode(statusCode: number): boolean {
  return statusCode === 429 || statusCode >= 500;
}

function classifyError(error: unknown): EmailSendError {
  if (error instanceof EmailSendError) return error;

  const message =
    error instanceof Error ? error.message : "Unknown email send error";

  if (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof (error as { statusCode: unknown }).statusCode === "number"
  ) {
    const statusCode = (error as { statusCode: number }).statusCode;
    return new EmailSendError(message, {
      retryable: isRetryableStatusCode(statusCode),
      statusCode,
      cause: error,
    });
  }

  const lowerMessage = message.toLowerCase();
  const retryable =
    lowerMessage.includes("rate limit") ||
    lowerMessage.includes("timeout") ||
    lowerMessage.includes("econnreset") ||
    lowerMessage.includes("econnrefused") ||
    lowerMessage.includes("network");

  return new EmailSendError(message, { retryable, cause: error });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const exponentialDelay = baseDelayMs * 2 ** attempt;
  const jitter = Math.random() * baseDelayMs;
  return Math.min(exponentialDelay + jitter, maxDelayMs);
}

async function withRetry<T>(
  fn: () => Promise<T>,
  options: Required<RetryOptions>,
): Promise<T> {
  let lastError: EmailSendError | undefined;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = classifyError(error);

      if (!lastError.retryable || attempt === options.maxRetries) {
        throw lastError;
      }

      const delay = getBackoffDelay(
        attempt,
        options.baseDelayMs,
        options.maxDelayMs,
      );
      await sleep(delay);
    }
  }

  throw (
    lastError ?? new EmailSendError("Retry exhausted", { retryable: false })
  );
}

export async function sendEmail(
  client: Resend,
  options: SendEmailOptions,
  retryOptions?: RetryOptions,
): Promise<SendResult> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...retryOptions };

  return withRetry(async () => {
    const { data, error } = await client.emails.send({
      from: options.from,
      to: normalizeRecipients(options.to),
      subject: options.subject,
      react: options.react,
      replyTo: options.replyTo,
      cc: options.cc,
      bcc: options.bcc,
      scheduledAt: options.scheduledAt,
      tags: options.tags,
      headers: options.headers,
    });

    if (error) {
      throw new EmailSendError(`Failed to send email: ${error.message}`, {
        retryable:
          "statusCode" in error &&
          typeof (error as { statusCode: unknown }).statusCode === "number"
            ? isRetryableStatusCode(
                (error as { statusCode: number }).statusCode,
              )
            : false,
        statusCode:
          "statusCode" in error
            ? ((error as { statusCode: unknown }).statusCode as number)
            : undefined,
      });
    }

    if (!data) {
      throw new EmailSendError("Failed to send email: no data returned", {
        retryable: true,
      });
    }

    return { id: data.id };
  }, opts);
}

export async function sendBatchEmails(
  client: Resend,
  emails: BatchEmailItem[],
  retryOptions?: RetryOptions,
): Promise<SendResult[]> {
  if (emails.length === 0) return [];

  const chunks: BatchEmailItem[][] = [];
  for (let i = 0; i < emails.length; i += BATCH_CHUNK_SIZE) {
    chunks.push(emails.slice(i, i + BATCH_CHUNK_SIZE));
  }

  const allResults: SendResult[] = [];

  for (const chunk of chunks) {
    const results = await sendBatchChunk(client, chunk, retryOptions);
    allResults.push(...results);
  }

  return allResults;
}

async function sendBatchChunk(
  client: Resend,
  emails: BatchEmailItem[],
  retryOptions?: RetryOptions,
): Promise<SendResult[]> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...retryOptions };

  return withRetry(async () => {
    const { data, error } = await client.batch.send(
      emails.map((email) => ({
        from: email.from,
        to: normalizeRecipients(email.to),
        subject: email.subject,
        react: email.react,
        replyTo: email.replyTo,
        cc: email.cc,
        bcc: email.bcc,
        tags: email.tags,
        headers: email.headers,
      })),
    );

    if (error) {
      throw new EmailSendError(
        `Failed to send batch emails: ${error.message}`,
        {
          retryable:
            "statusCode" in error &&
            typeof (error as { statusCode: unknown }).statusCode === "number"
              ? isRetryableStatusCode(
                  (error as { statusCode: number }).statusCode,
                )
              : false,
          statusCode:
            "statusCode" in error
              ? ((error as { statusCode: unknown }).statusCode as number)
              : undefined,
        },
      );
    }

    if (!data) {
      throw new EmailSendError(
        "Failed to send batch emails: no data returned",
        { retryable: true },
      );
    }

    return data.data.map((item: { id: string }) => ({ id: item.id }));
  }, opts);
}
