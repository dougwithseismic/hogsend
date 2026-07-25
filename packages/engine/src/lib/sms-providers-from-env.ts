import type { SmsProvider } from "@hogsend/core";
import type { env as envSchema } from "../env.js";
import { recordBootDiagnostic } from "./boot-diagnostics.js";
import { loadOptionalPlugin } from "./load-optional-plugin.js";

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
  // Previously a bare `catch {}` that swallowed the failure with no log at all:
  // a Twilio-configured deploy registered no provider, the container installed
  // the inert throwing stub, and the first symptom was `sendSms` throwing at
  // send time with nothing at boot to explain why. Report it where it happens.
  createTwilioProvider = await loadOptionalPlugin<CreateTwilioProvider>({
    specifier: TWILIO_PACKAGE,
    exportName: "createTwilioProvider",
    enabledBy: "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are set",
    onFailure: (message) => console.warn(message),
  });
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

  // Creds-without-sender was the one FULLY silent skip in the env presets:
  // the guard below deliberately skips the preset, the container then installs
  // the inert throwing SMS stub, and the first symptom was `sendSms` throwing
  // at send time with nothing at boot to explain why. Detect it here (keyed on
  // the env actually passed, independent of whether the plugin loaded) and
  // report on both channels — stdout warn + boot diagnostic.
  if (
    env.TWILIO_ACCOUNT_SID &&
    env.TWILIO_AUTH_TOKEN &&
    !env.SMS_FROM &&
    !env.TWILIO_MESSAGING_SERVICE_SID
  ) {
    const message =
      "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are set, but neither " +
      "SMS_FROM nor TWILIO_MESSAGING_SERVICE_SID is — Twilio cannot send " +
      "without a sender, so the preset is skipped and the SMS service boots " +
      "as an inert stub (sendSms throws at send time). Set SMS_FROM (an " +
      "E.164 number) or TWILIO_MESSAGING_SERVICE_SID.";
    console.warn(message);
    recordBootDiagnostic({ code: "sms.no-sender", message });
  }

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
