import type { AnalyticsProvider } from "@hogsend/core";
import type { Database } from "@hogsend/db";
import {
  createPostHogProvider,
  deriveIngestHost,
  type PostHogAuthTokenAccessor,
} from "@hogsend/plugin-posthog";
import type { env as envSchema } from "../env.js";
import type { AnalyticsProviderRegistry } from "./analytics-provider-registry.js";
import { setAnalytics } from "./analytics-singleton.js";
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
 * (provider_credentials kind="derived", `projectApiKey`): when NO analytics
 * provider resolved at boot and no `POSTHOG_API_KEY` is set, build the PostHog
 * provider from the store and activate it — registry, `client.analytics`, the
 * module singleton, and a rebuilt identity service (its boot-time closure
 * captured `undefined`). Without this the persisted key is dead weight and
 * outbound capture silently keeps requiring a hand-pasted env var.
 *
 * Runs async right after `createHogsendClient` returns (the container is
 * built synchronously; this is the same construct-now-credentials-arrive-async
 * posture as the OAuth token manager). Fire-and-forget: any failure leaves the
 * container exactly as booted (analytics undefined, reads/mirror no-ops).
 *
 * The capture host resolves env-first, then the stored value, then the
 * ingestion host derived from the stored PRIVATE host (`eu.posthog.com` →
 * `eu.i.posthog.com`) so an EU-connected instance never captures to the US
 * default.
 */
export async function activateStoredPosthogAnalytics(opts: {
  client: { analytics?: AnalyticsProvider };
  registry: AnalyticsProviderRegistry;
  env: typeof envSchema;
  db: Database;
  logger: Logger;
  /** Re-bind boot closures that captured `analytics: undefined`. */
  onActivate: (provider: AnalyticsProvider) => void;
}): Promise<boolean> {
  let derived: Awaited<ReturnType<typeof getDerivedCredential>>;
  try {
    derived = await getDerivedCredential(opts.db, "posthog");
  } catch {
    return false; // undecryptable/unreadable → behave exactly as unconfigured
  }
  if (!derived?.projectApiKey) return false;
  // Someone else claimed the slot while we read (consumer provider, race).
  if (opts.client.analytics || opts.registry.get("posthog")) return false;

  const provider = buildPosthogProvider(
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
  opts.registry.register(provider);
  opts.client.analytics = provider;
  setAnalytics(provider);
  opts.onActivate(provider);
  opts.logger.info(
    'analytics provider "posthog" activated from the stored `hogsend connect posthog` credential — outbound capture is live without POSTHOG_API_KEY.',
  );
  return true;
}
