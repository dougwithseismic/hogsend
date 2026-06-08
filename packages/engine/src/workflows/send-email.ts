import { NonRetryableError } from "@hatchet-dev/typescript-sdk/v1/index.js";
import { EmailSendError } from "@hogsend/email";
import { getEmailService } from "../lib/email.js";
import { hatchet } from "../lib/hatchet.js";

export const sendEmailTask = hatchet.task({
  name: "send-email",
  // The EmailProvider owns transient-failure backoff internally (classified
  // exponential retry in its `send`), and permanent failures fail fast below via
  // NonRetryableError — so Hatchet's retry is just ONE durability re-attempt for a
  // worker crash/timeout, not a second transient-retry loop layered on the
  // provider's. (Previously 3, which multiplied with the provider's own retries.)
  retries: 1,
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
    // Deliver through the injected, provider-backed mailer (set by
    // createHogsendClient → setEmailService). `sendRaw` calls the swappable
    // EmailProvider's `send`, resolving the default `from` from the mailer
    // config — so a swapped provider is honored and this task no longer
    // constructs a raw Resend client of its own. The provider already retries
    // transient failures internally and surfaces a classified EmailSendError;
    // map a non-retryable one to Hatchet's NonRetryableError so the task's own
    // retry/backoff doesn't re-attempt a permanent failure.
    const emailService = getEmailService();

    try {
      // `from` is optional: when absent the mailer's `resolveFrom` falls back to
      // its configured defaultFrom (env.RESEND_FROM_EMAIL). The neutral
      // `tags: {name,value}[]` shape passes straight through to the provider wire.
      const result = await emailService.sendRaw({
        from: input.from,
        to: input.to,
        subject: input.subject,
        html: input.html,
        replyTo: input.replyTo,
        tags: input.tags,
        headers: input.headers,
      });

      return { emailId: result.id };
    } catch (error) {
      if (error instanceof EmailSendError && !error.retryable) {
        throw new NonRetryableError(error.message);
      }
      throw error;
    }
  },
});
