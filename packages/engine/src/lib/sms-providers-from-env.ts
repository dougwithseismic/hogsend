import type { SmsProvider } from "@hogsend/core";
import type { env as envSchema } from "../env.js";

/**
 * `@hogsend/plugin-twilio` is an OPT-IN, deferred-publish package — an engine
 * `optionalDependency`, NOT a hard one. Mirroring the Postmark pattern in
 * `email-providers-from-env.ts`, we MUST NOT statically import it: a static
 * import would make the package mandatory at engine load and break
 * `npm install @hogsend/engine` for every consumer without it.
 *
 * Instead we load it lazily, ONCE, behind a top-level guarded dynamic import
 * gated on the Twilio credentials being present. The specifier is assembled at
 * runtime (not a literal) so `tsc` never tries to resolve the module's types for
 * a consumer that doesn't have the opt-in package installed.
 */
type CreateTwilioProvider = (cfg: {
  accountSid: string;
  authToken: string;
  from?: string;
  messagingServiceSid?: string;
  statusCallbackUrl?: string;
}) => SmsProvider;

const TWILIO_PACKAGE = ["@hogsend", "plugin-twilio"].join("/");

let createTwilioProvider: CreateTwilioProvider | null = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  try {
    ({ createTwilioProvider } = (await import(TWILIO_PACKAGE)) as {
      createTwilioProvider: CreateTwilioProvider;
    });
  } catch {
    // Credentials set but the opt-in package isn't installed. Leave the factory
    // null — `smsProvidersFromEnv` skips the preset, and if Twilio was the
    // resolved active provider the container throws a clear "not registered"
    // error directing the operator to install `@hogsend/plugin-twilio`.
    createTwilioProvider = null;
  }
}

/**
 * Build the env-enabled SMS-provider presets. A preset is constructed ONLY when
 * its credentials are present, so a deploy without Twilio creds contributes no
 * provider (and the container installs an inert throwing-stub SMS service).
 *
 * These presets come FIRST in the container's merge — a consumer-supplied
 * provider of the same id wins (last-writer-wins on the registry).
 */
/**
 * A non-public `API_PUBLIC_URL` (localhost / loopback) cannot receive Twilio's
 * status callback, and Twilio REJECTS a localhost `statusCallback` outright
 * (error 21609 — the send 400s). So we only auto-attach the callback when the
 * public URL is genuinely reachable — local `pnpm dev` sends then succeed (with
 * no delivery receipts, which localhost can't receive anyway), while a real
 * deploy still wires the callback.
 */
function isPubliclyReachable(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return !(
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host.endsWith(".local")
    );
  } catch {
    return false;
  }
}

export function smsProvidersFromEnv(env: typeof envSchema): SmsProvider[] {
  const providers: SmsProvider[] = [];

  if (
    env.TWILIO_ACCOUNT_SID &&
    env.TWILIO_AUTH_TOKEN &&
    createTwilioProvider &&
    // Twilio needs a sender to construct; skip the preset (rather than throw at
    // boot) when neither a from-number nor a messaging service is configured.
    (env.SMS_FROM || env.TWILIO_MESSAGING_SERVICE_SID)
  ) {
    const statusCallbackUrl = isPubliclyReachable(env.API_PUBLIC_URL)
      ? `${env.API_PUBLIC_URL}/v1/webhooks/sms/twilio`
      : undefined;
    providers.push(
      createTwilioProvider({
        accountSid: env.TWILIO_ACCOUNT_SID,
        authToken: env.TWILIO_AUTH_TOKEN,
        ...(env.SMS_FROM ? { from: env.SMS_FROM } : {}),
        ...(env.TWILIO_MESSAGING_SERVICE_SID
          ? { messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID }
          : {}),
        ...(statusCallbackUrl ? { statusCallbackUrl } : {}),
      }),
    );
  }

  return providers;
}
