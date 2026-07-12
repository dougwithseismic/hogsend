import type { VoiceProvider } from "@hogsend/core";
import type { env as envSchema } from "../env.js";

/**
 * `@hogsend/plugin-vapi` is an OPT-IN, deferred-publish package — an engine
 * `optionalDependency`, NOT a hard one. Mirroring the Twilio/Postmark patterns,
 * we MUST NOT statically import it: a static import would make the package
 * mandatory at engine load and break `npm install @hogsend/engine` for every
 * consumer without it.
 *
 * Instead we load it lazily, ONCE, behind a top-level guarded dynamic import
 * gated on the Vapi credentials being present. The specifier is assembled at
 * runtime (not a literal) so `tsc` never tries to resolve the module's types.
 */
type CreateVapiProvider = (cfg: {
  apiKey: string;
  phoneNumberId: string;
  serverUrl?: string;
  webhookSecret?: string;
}) => VoiceProvider;

const VAPI_PACKAGE = ["@hogsend", "plugin-vapi"].join("/");

let createVapiProvider: CreateVapiProvider | null = null;
if (process.env.VAPI_API_KEY && process.env.VAPI_PHONE_NUMBER_ID) {
  try {
    ({ createVapiProvider } = (await import(VAPI_PACKAGE)) as {
      createVapiProvider: CreateVapiProvider;
    });
  } catch {
    // Credentials set but the opt-in package isn't installed. Leave the factory
    // null — `voiceProvidersFromEnv` skips the preset, and if Vapi was the
    // resolved active provider the container throws a clear "not registered"
    // error directing the operator to install `@hogsend/plugin-vapi`.
    createVapiProvider = null;
  }
}

/**
 * A non-public `API_PUBLIC_URL` (localhost / loopback) can't receive Vapi's
 * webhooks, so we only wire the server URL when the public URL is genuinely
 * reachable — local `pnpm dev` calls still place (with no status/tool webhooks,
 * which localhost can't receive anyway), while a real deploy routes them back.
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

/**
 * Build the env-enabled voice-provider presets. A preset is constructed ONLY
 * when its credentials are present, so a deploy without Vapi creds contributes
 * no provider (and the container installs an inert throwing-stub voice service).
 *
 * These presets come FIRST in the container's merge — a consumer-supplied
 * provider of the same id wins (last-writer-wins on the registry).
 */
export function voiceProvidersFromEnv(env: typeof envSchema): VoiceProvider[] {
  const providers: VoiceProvider[] = [];

  if (env.VAPI_API_KEY && env.VAPI_PHONE_NUMBER_ID && createVapiProvider) {
    const serverUrl = isPubliclyReachable(env.API_PUBLIC_URL)
      ? `${env.API_PUBLIC_URL.replace(/\/+$/, "")}/v1/webhooks/voice/vapi`
      : undefined;
    providers.push(
      createVapiProvider({
        apiKey: env.VAPI_API_KEY,
        phoneNumberId: env.VAPI_PHONE_NUMBER_ID,
        ...(serverUrl ? { serverUrl } : {}),
        ...(env.VAPI_WEBHOOK_SECRET
          ? { webhookSecret: env.VAPI_WEBHOOK_SECRET }
          : {}),
      }),
    );
  }

  return providers;
}
