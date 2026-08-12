import { normalizeRecipients } from "@hogsend/core";
import {
  DEFAULT_RETRY_OPTIONS,
  EmailSendError,
  type RetryOptions,
} from "@hogsend/email";
import type { Resend, Attachment as ResendAttachment } from "resend";
import type { BatchEmailItem, SendEmailOptions, SendResult } from "./types.js";

const BATCH_CHUNK_SIZE = 100;

/**
 * Translate the neutral attachments onto Resend's send-side `Attachment` shape.
 * Returns `undefined` for absent/empty input so the field never appears on the
 * wire and existing no-attachment sends stay byte-identical.
 *
 * - `Uint8Array` → `Buffer` (Resend accepts raw bytes and does its own wire
 *   encoding). `{ base64 }` → the string UNTOUCHED — Resend interprets string
 *   content as base64, so decoding and re-encoding here would be pure loss.
 * - `path` is NEVER set: it makes Resend fetch a remote URL, which is not what
 *   the neutral contract means and would be an SSRF-shaped surprise.
 * - Resend's send-side attachment has NO disposition field (the read-side
 *   `AttachmentData` is a different type) — inline is expressed solely by
 *   `contentId` ("If set, this attachment will be sent as an inline attachment
 *   … reference it in the HTML content using the `cid:` prefix"). So
 *   `disposition: "inline"` with NO `contentId` has no representation on this
 *   wire, and we DEGRADE it to a regular attachment rather than throw: nothing
 *   in the HTML can reference an attachment without a contentId, so no image
 *   can fail to render — only a presentation hint is lost, never content — and
 *   throwing would fail a message whose files are all deliverable on the one
 *   provider that can't express the hint.
 */
function toResendAttachments(
  attachments: SendEmailOptions["attachments"],
): ResendAttachment[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((a) => ({
    filename: a.filename,
    content:
      a.content instanceof Uint8Array
        ? Buffer.from(a.content)
        : a.content.base64,
    ...(a.contentType !== undefined ? { contentType: a.contentType } : {}),
    // Resend's contentId is the BARE id — the HTML adds the `cid:` prefix.
    ...(a.contentId !== undefined ? { contentId: a.contentId } : {}),
  }));
}

/**
 * Resend rejects tag names/values outside ASCII letters, numbers, underscores
 * and dashes. The engine's neutral tags carry journey names ("Docs Subscriber")
 * and template keys ("docs/welcome"), so map anything else to "-" rather than
 * failing the whole send.
 */
function sanitizeTags(
  tags: SendEmailOptions["tags"],
): SendEmailOptions["tags"] {
  return tags?.map((tag) => ({
    name: tag.name.replace(/[^a-zA-Z0-9_-]/g, "-"),
    value: tag.value.replace(/[^a-zA-Z0-9_-]/g, "-"),
  }));
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

export async function sendEmail(args: {
  client: Resend;
  options: SendEmailOptions;
  retryOptions?: RetryOptions;
}): Promise<SendResult> {
  const { client, options, retryOptions } = args;
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...retryOptions };
  const attachments = toResendAttachments(options.attachments);

  return withRetry(async () => {
    const { data, error } = await client.emails.send({
      from: options.from,
      to: normalizeRecipients(options.to),
      subject: options.subject,
      // HTML-ONLY wire — the engine always renders React → HTML before the
      // provider, so no React ever reaches Resend here.
      html: options.html,
      text: options.text,
      replyTo: options.replyTo,
      cc: options.cc,
      bcc: options.bcc,
      scheduledAt: options.scheduledAt,
      // Resend accepts neutral `{name,value}[]` tags natively — sanitized to
      // its allowed charset (see sanitizeTags).
      tags: sanitizeTags(options.tags),
      headers: options.headers,
      // Conditional spread (not `attachments: undefined`) so a no-attachment
      // send carries NO attachments key at all — byte-identical to before.
      ...(attachments ? { attachments } : {}),
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

export async function sendBatchEmails(args: {
  client: Resend;
  emails: BatchEmailItem[];
  retryOptions?: RetryOptions;
}): Promise<SendResult[]> {
  const { client, emails, retryOptions } = args;
  if (emails.length === 0) return [];

  // Resend's batch API CANNOT carry attachments — the SDK pins it:
  // `CreateBatchEmailOptions = Omit<CreateEmailOptions, 'attachments' |
  // 'scheduledAt'>` ("not supported in the batch API"). Passing them anyway
  // would not error; the files would just never arrive — the exact silent
  // failure `capabilities.attachments` exists to prevent (a receipt minus its
  // invoice looks delivered from every dashboard). So a batch containing ANY
  // attachment falls back to per-item single sends — the only wire Resend
  // offers for the job, and the shape the neutral contract anticipates
  // ("every provider's sendBatch is (or wraps) a loop over single sends").
  // Each item keeps its own retry loop and results keep the input order. The
  // common no-attachment path below is untouched and byte-identical.
  if (emails.some((e) => e.attachments && e.attachments.length > 0)) {
    const results: SendResult[] = [];
    for (const email of emails) {
      results.push(await sendEmail({ client, options: email, retryOptions }));
    }
    return results;
  }

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
        // HTML-ONLY wire — no React reaches Resend.
        html: email.html,
        text: email.text,
        replyTo: email.replyTo,
        cc: email.cc,
        bcc: email.bcc,
        // Resend accepts neutral `{name,value}[]` tags — sanitized to its charset.
        tags: sanitizeTags(email.tags),
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
