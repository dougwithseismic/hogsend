import type { AnalyticsProvider } from "@hogsend/core";
import type { Database } from "@hogsend/db";
import {
  createPostHogProvider,
  deriveIngestHost,
  type PostHogAuthTokenAccessor,
} from "@hogsend/plugin-posthog";
import type { env as envSchema } from "../env.js";
import type { Logger } from "./logger.js";
import { createTokenManager } from "./oauth-token-manager.js";
import { getDerivedCredential } from "./provider-credentials.js";
import { getRedis } from "./redis.js";

/**
 * Env-driven analytics-provider presets — the analytics sibling of
 * `emailProvidersFromEnv`. PostHog is built when `POSTHOG_API_KEY` is set;
 * person READS additionally need a privileged credential: an OAuth credential
 * stored via `hogsend connect posthog` (preferred, token-manager-backed) or
 * `POSTHOG_PERSONAL_API_KEY` (the public phc_ key is write-only by PostHog's
 * design) — without either the provider still captures and writes person
 * properties, and reads soft-fail to the engine's contact-property fallback.
 *
 * Consumer-supplied providers (`analytics.providers` / `analytics.provider`)
 * merge AFTER these in the registry, so a consumer build of the same id wins.
 */
export function analyticsProvidersFromEnv(
  env: typeof envSchema,
  deps?: { db?: Database; logger?: Logger },
): AnalyticsProvider[] {
  const providers: AnalyticsProvider[] = [];

  if (env.POSTHOG_API_KEY) {
    providers.push(
      buildPosthogProvider(env, deps, { apiKey: env.POSTHOG_API_KEY }),
    );
  }

  return providers;
}

/**
 * Construct the PostHog provider with the token-manager-backed OAuth accessor.
 * Shared by the env preset above (`POSTHOG_API_KEY`) and the stored-credential
 * activation below (`hogsend connect posthog`'s persisted phc_). Env values
 * win over `source` overrides so a hand-set var still takes precedence.
 */
function buildPosthogProvider(
  env: typeof envSchema,
  deps: { db?: Database; logger?: Logger } | undefined,
  source: {
    apiKey: string;
    host?: string;
    projectId?: string;
    privateHost?: string;
  },
): AnalyticsProvider {
  // Token-manager-backed accessor: the manager re-checks the DB (30s
  // negative cache), so a credential stored at RUNTIME via
  // `hogsend connect posthog` comes alive without a restart.
  let authToken: PostHogAuthTokenAccessor | undefined;
  if (deps?.db) {
    const tokenManager = createTokenManager({
      db: deps.db,
      providerId: "posthog",
      logger: deps.logger,
    });
    // Load-only warm-up (no refresh, never blocks construction). The
    // person-reads nudge logs HERE, after the load settles — the container
    // can't log it truthfully at boot because capabilities resolve async
    // for OAuth-capable providers (a connected instance would otherwise
    // log "DISABLED" once on every boot).
    const personalKeySet = Boolean(env.POSTHOG_PERSONAL_API_KEY);
    void tokenManager
      .prime()
      .then(() => {
        if (!personalKeySet && tokenManager.credentialState() !== "present") {
          deps.logger?.info(
            'analytics provider "posthog" has person reads DISABLED — ' +
              "timezone resolution falls back to contact properties. Set " +
              "POSTHOG_PERSONAL_API_KEY or run `hogsend connect posthog`. " +
              "Docs: https://hogsend.com/docs/guides/analytics-access",
          );
        }
      })
      .catch(() => {});
    authToken = {
      getToken: () => tokenManager.getAccessToken(),
      isAvailable: () => tokenManager.credentialState() === "present",
    };
  }
  return createPostHogProvider({
    apiKey: source.apiKey,
    host: env.POSTHOG_HOST ?? source.host,
    personalApiKey: env.POSTHOG_PERSONAL_API_KEY,
    projectId: env.POSTHOG_PROJECT_ID ?? source.projectId,
    privateHost: env.POSTHOG_PRIVATE_HOST ?? source.privateHost,
    redis: getRedis(),
    authToken,
  });
}

/**
 * Boot-time reader for the phc_ persisted by `hogsend connect posthog`
 * (provider_credentials kind="derived", `projectApiKey`): a PURE builder —
 * reads the stored credential and constructs the PostHog provider from it, or
 * resolves null when there is nothing stored (or it can't be decrypted, which
 * must behave exactly like "unconfigured"). ALL activation side effects
 * (registry, `client.analytics`, the module singleton, identity rebind) live
 * at the single call site in `container.ts`. Without this reader the
 * persisted key is dead weight and outbound capture silently keeps requiring
 * a hand-pasted env var.
 *
 * The capture host resolves env-first, then the ingestion host derived from
 * the stored PRIVATE host (`eu.posthog.com` → `eu.i.posthog.com`) so an
 * EU-connected instance never captures to the US default.
 */
export async function buildStoredPosthogProvider(opts: {
  env: typeof envSchema;
  db: Database;
  logger: Logger;
}): Promise<AnalyticsProvider | null> {
  let derived: Awaited<ReturnType<typeof getDerivedCredential>>;
  try {
    derived = await getDerivedCredential(opts.db, "posthog");
  } catch {
    return null;
  }
  if (!derived?.projectApiKey) return null;

  return buildPosthogProvider(
    opts.env,
    { db: opts.db, logger: opts.logger },
    {
      apiKey: derived.projectApiKey,
      projectId: derived.projectId,
      privateHost: derived.privateHost,
      host: derived.privateHost
        ? deriveIngestHost(derived.privateHost)
        : undefined,
    },
  );
}
