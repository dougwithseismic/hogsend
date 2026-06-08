import type { EmailProvider } from "@hogsend/core";
import { createResendProvider } from "@hogsend/plugin-resend";
import type { env as envSchema } from "../env.js";

/**
 * Build the env-enabled email-provider presets. Mirrors `destinationsFromEnv`:
 * a preset is constructed ONLY when its credential is present, so a
 * Postmark-only deploy (no `RESEND_API_KEY`) contributes no Resend provider.
 *
 * These presets come FIRST in the container's merge — a consumer-supplied
 * provider of the same id wins (last-writer-wins on the registry).
 */
export function emailProvidersFromEnv(env: typeof envSchema): EmailProvider[] {
  const providers: EmailProvider[] = [];

  if (env.RESEND_API_KEY) {
    providers.push(
      createResendProvider({
        apiKey: env.RESEND_API_KEY,
        webhookSecret: env.RESEND_WEBHOOK_SECRET,
      }),
    );
  }

  // future: if (env.POSTMARK_SERVER_TOKEN) providers.push(createPostmarkProvider(...))

  return providers;
}
