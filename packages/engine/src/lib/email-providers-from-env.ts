import type { EmailProvider } from "@hogsend/core";
import { createPostmarkProvider } from "@hogsend/plugin-postmark";
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

  // Postmark is OPT-IN: built only when its token is present, and it never
  // changes the default active provider — set EMAIL_PROVIDER=postmark to
  // activate it. Postmark has no HMAC, so webhook auth is HTTP Basic creds (the
  // provider fails closed when they're unset).
  if (env.POSTMARK_SERVER_TOKEN) {
    providers.push(
      createPostmarkProvider({
        serverToken: env.POSTMARK_SERVER_TOKEN,
        ...(env.POSTMARK_MESSAGE_STREAM
          ? { messageStream: env.POSTMARK_MESSAGE_STREAM }
          : {}),
        ...(env.POSTMARK_WEBHOOK_USER && env.POSTMARK_WEBHOOK_PASS
          ? {
              webhookBasicAuth: {
                user: env.POSTMARK_WEBHOOK_USER,
                pass: env.POSTMARK_WEBHOOK_PASS,
              },
            }
          : {}),
      }),
    );
  }

  return providers;
}
