import type { EmailProvider } from "@hogsend/core";
import { createResendProvider } from "@hogsend/plugin-resend";
import type { env as envSchema } from "../env.js";

/**
 * `@hogsend/plugin-postmark` is an OPT-IN, deferred-publish package: it is an
 * engine `optionalDependency`, NOT a hard one, and it is not on the npm registry
 * yet. So we MUST NOT statically import it — a static `import` would make the
 * package mandatory at engine load, and `npm install @hogsend/engine` would fail
 * with E404 on plugin-postmark for every consumer that doesn't have it.
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
  try {
    ({ createPostmarkProvider } = (await import(POSTMARK_PACKAGE)) as {
      createPostmarkProvider: CreatePostmarkProvider;
    });
  } catch {
    // The token is set but the opt-in package isn't installed. Leave the factory
    // null — `emailProvidersFromEnv` skips the preset, and if Postmark was the
    // resolved active provider the container throws a clear "not registered"
    // error directing the operator to install `@hogsend/plugin-postmark`.
    createPostmarkProvider = null;
  }
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

  return providers;
}
