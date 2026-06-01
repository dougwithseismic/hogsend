import { NonRetryableError } from "@hatchet-dev/typescript-sdk/v1/index.js";
import { createResendClient } from "@hogsend/plugin-resend";
import { hatchet } from "../lib/hatchet.js";

const resend = createResendClient({
  apiKey: process.env.RESEND_API_KEY ?? "",
});

const NON_RETRYABLE_CODES = new Set([
  "validation_error",
  "missing_required_field",
  "invalid_api_key",
  "not_found",
  "restricted_api_key",
]);

export const sendEmailTask = hatchet.task({
  name: "send-email",
  retries: 3,
  executionTimeout: "30s",
  backoff: { factor: 2, maxSeconds: 30 },
  fn: async (input: {
    to: string;
    subject: string;
    html: string;
    from?: string;
    replyTo?: string;
    tags?: Array<{ name: string; value: string }>;
    headers?: Record<string, string>;
  }) => {
    const { data, error } = await resend.emails.send({
      from:
        input.from ??
        process.env.RESEND_FROM_EMAIL ??
        "Hogsend <noreply@hogsend.com>",
      to: input.to,
      subject: input.subject,
      html: input.html,
      replyTo: input.replyTo,
      tags: input.tags,
      headers: input.headers,
    });

    if (error) {
      const name = (error as { name?: string }).name ?? "";
      if (NON_RETRYABLE_CODES.has(name)) {
        throw new NonRetryableError(`${name}: ${error.message}`);
      }
      throw new Error(`Failed to send email: ${error.message}`);
    }

    return { emailId: data?.id ?? "" };
  },
});
