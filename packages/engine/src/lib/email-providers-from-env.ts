import type { EmailProvider } from "@hogsend/core";
import { createResendProvider } from "@hogsend/plugin-resend";
import type { env as envSchema } from "../env.js";
import { loadOptionalPlugin } from "./load-optional-plugin.js";

/**
 * `@hogsend/plugin-postmark` is an OPT-IN package: an engine
 * `optionalDependency`, NOT a hard one. So we MUST NOT statically import it — a
 * static `import` would make the package mandatory at engine load for every
 * consumer, including the ones that never send through Postmark.
 *
 * Instead we load it lazily, ONCE, behind a top-level guarded dynamic import:
 * the `import()` only fires when `POSTMARK_SERVER_TOKEN` is present (the same
 * gate the preset below uses), so a deploy that never sets that var never
 * touches the package and degrades gracefully when it isn't installed. ESM
 * top-level await keeps `emailProvidersFromEnv` itself synchronous (it reads the
 * already-resolved factory), so `createHogsendClient` stays synchronous.
 *
 * The specifier is assembled at runtime (not a string literal) ON PURPOSE: a
 * literal `import("@hogsend/plugin-postmark")` makes `tsc` resolve the module's
 * types, which fails with TS2307 for any consumer that doesn't have the opt-in
 * package installed (e.g. a fresh `create-hogsend` app). A computed specifier is
 * opaque to the type-checker — resolved only at runtime — so the engine
 * type-checks identically with or without the package present.
 */
type CreatePostmarkProvider = (cfg: {
  serverToken: string;
  messageStream?: string;
  webhookBasicAuth?: { user: string; pass: string };
  accountToken?: string;
}) => EmailProvider;

const POSTMARK_PACKAGE = ["@hogsend", "plugin-postmark"].join("/");

let createPostmarkProvider: CreatePostmarkProvider | null = null;
if (process.env.POSTMARK_SERVER_TOKEN) {
  // Previously a bare `catch {}` that swallowed the failure silently. If
  // Postmark was the resolved active provider the container still threw its
  // "not registered" boot error, but a deploy that merely set the token fell
  // back to Resend with nothing in the logs to say why.
  createPostmarkProvider = await loadOptionalPlugin<CreatePostmarkProvider>({
    specifier: POSTMARK_PACKAGE,
    exportName: "createPostmarkProvider",
    enabledBy: "POSTMARK_SERVER_TOKEN is set",
    onFailure: (message) => console.warn(message),
  });
}

/**
 * `@hogsend/plugin-hogsend` is OPT-IN for exactly the same reasons as Postmark,
 * and loaded exactly the same way: an engine `optionalDependency` behind a
 * top-level guarded dynamic import whose specifier is ASSEMBLED AT RUNTIME. A
 * string literal here would make `tsc` resolve the module's types and fail with
 * TS2307 for every consumer that doesn't have the package installed — including
 * every fresh `create-hogsend` app, which is not covered by this repo's own
 * type-check and so would only surface after publish.
 *
 * The gate is `HOGSEND_EMAIL_TOKEN`: absent, the `import()` never fires, so a
 * self-hosted deploy that will never send through Hogsend Cloud never touches
 * the package.
 */
type CreateHogsendEmailProvider = (cfg: {
  relayUrl: string;
  tenantToken: string;
  webhookSecret?: string;
}) => EmailProvider;

const HOGSEND_PACKAGE = ["@hogsend", "plugin-hogsend"].join("/");

let createHogsendEmailProvider: CreateHogsendEmailProvider | null = null;
if (process.env.HOGSEND_EMAIL_TOKEN) {
  createHogsendEmailProvider =
    await loadOptionalPlugin<CreateHogsendEmailProvider>({
      specifier: HOGSEND_PACKAGE,
      exportName: "createHogsendEmailProvider",
      enabledBy: "HOGSEND_EMAIL_TOKEN is set",
      onFailure: (message) => console.warn(message),
    });
}

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

  // Postmark is OPT-IN: built only when its token is present AND the opt-in
  // package resolved (see the guarded dynamic import above), and it never
  // changes the default active provider — set EMAIL_PROVIDER=postmark to
  // activate it. Postmark has no HMAC, so webhook auth is HTTP Basic creds (the
  // provider fails closed when they're unset).
  if (env.POSTMARK_SERVER_TOKEN && createPostmarkProvider) {
    providers.push(
      createPostmarkProvider({
        serverToken: env.POSTMARK_SERVER_TOKEN,
        ...(env.POSTMARK_MESSAGE_STREAM
          ? { messageStream: env.POSTMARK_MESSAGE_STREAM }
          : {}),
        // Account token unlocks the Domains API capability (optional).
        ...(env.POSTMARK_ACCOUNT_TOKEN
          ? { accountToken: env.POSTMARK_ACCOUNT_TOKEN }
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

  // Hogsend Email is OPT-IN twice over: the package only loads when
  // HOGSEND_EMAIL_TOKEN is set (see the guarded import above), and registering
  // it does NOT select it — EMAIL_PROVIDER=hogsend does, exactly as Postmark
  // works. The Cloud provisioner injects both, so a Cloud instance gets it by
  // default while every self-hosted default is untouched.
  //
  // The relay URL is required to BUILD it. A token with no URL is a
  // misconfiguration, and a provider aimed at `undefined/api/email/send` would
  // defer that config error to the first real send — so it warns here and skips.
  // If `hogsend` was the selected provider the container then throws its own
  // "not registered" error at boot, and the two lines together say exactly what
  // is missing.
  if (env.HOGSEND_EMAIL_TOKEN && createHogsendEmailProvider) {
    if (!env.HOGSEND_EMAIL_RELAY_URL) {
      console.warn(
        "HOGSEND_EMAIL_TOKEN is set, but its env preset is skipped: " +
          "HOGSEND_EMAIL_RELAY_URL is unset, so there is no Hogsend Cloud " +
          "control plane to relay sends to. Set it to your control plane " +
          "origin (Cloud provisioning injects it automatically).",
      );
    } else {
      providers.push(
        createHogsendEmailProvider({
          relayUrl: env.HOGSEND_EMAIL_RELAY_URL,
          tenantToken: env.HOGSEND_EMAIL_TOKEN,
          // Absent ⇒ the provider fails closed on every inbound webhook. Sends
          // still work; only status updates stop.
          ...(env.HOGSEND_EMAIL_WEBHOOK_SECRET
            ? { webhookSecret: env.HOGSEND_EMAIL_WEBHOOK_SECRET }
            : {}),
        }),
      );
    }
  }

  return providers;
}
