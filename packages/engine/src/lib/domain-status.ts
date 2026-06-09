import type { DomainStatus, EmailProvider } from "@hogsend/core";
import type { env as envSchema } from "../env.js";
import type { Logger } from "./logger.js";

/**
 * Per-send test-mode snapshot (PROJECT_SPEC pinned shape).
 *
 * F1 ships the FULL shape STUBBED INACTIVE — `testModeCached()` and the
 * `testMode` block of `getStatus()` always return
 * `{ active: false, reason: null, redirectTo: null, fromOverride: null }`.
 * F3 test-mode-sends replaces this stub with the real env-flag +
 * domain-unverified logic; every surface that renders the block (admin route,
 * CLI, Studio) lights up with zero further changes.
 */
export interface TestModeState {
  active: boolean;
  reason: "env_flag" | "domain_unverified" | null;
  /** HOGSEND_TEST_EMAIL ?? STUDIO_ADMIN_EMAIL ?? null (F3). */
  redirectTo: string | null;
  /** "onboarding@resend.dev" when providerId==="resend" && active (F3); else null. */
  fromOverride: string | null;
}

/**
 * The engine-level domain snapshot every surface consumes: the admin route
 * (`GET /v1/admin/domain`), the CLI (`hogsend domain status`), Studio's Setup
 * view, and (cached, F3) the mailer's test-mode check.
 */
export interface EngineDomainStatus {
  /**
   * EMAIL_DOMAIN ?? host part of EMAIL_FROM (?? RESEND_FROM_EMAIL); `null`
   * when underivable.
   */
  domain: string | null;
  providerId: string;
  /** `!!provider.domains` — presence of the capability is the gate. */
  supported: boolean;
  /** `null` when `!supported || !domain` (the provider is never called then). */
  status: DomainStatus | null;
  testMode: TestModeState;
}

/**
 * Cached domain-status service. The per-send safety contract:
 * `isVerifiedCached()`/`testModeCached()` are SYNC and cache-only (never await
 * a provider call, never throw), and `refreshIfStale()` is fire-and-forget —
 * so the mailer's hot path adds zero provider latency.
 */
export interface DomainStatusService {
  /** `refresh: true` bypasses + busts the cache (admin `?refresh=true`, CLI `domain check`). */
  getStatus(opts?: { refresh?: boolean }): Promise<EngineDomainStatus>;
  /**
   * Cache-only, NEVER awaits a provider call, never throws. FAIL-OPEN: no
   * cache entry / unknown ⇒ `true`, so a provider outage can never silently
   * redirect production mail.
   */
  isVerifiedCached(): boolean;
  /** Sync snapshot for the per-send path (mailer). Cache-only. */
  testModeCached(): TestModeState;
  /**
   * Fire-and-forget refresh when the cache is stale; called by the mailer per
   * send and once at boot. Cheap no-op when fresh; concurrent refreshes are
   * deduped; errors are swallowed + `logger.warn`ed.
   */
  refreshIfStale(): void;
}

/** TTL once the domain is verified — re-checks are cheap insurance only. */
const VERIFIED_TTL_MS = 10 * 60 * 1000;
/** TTL while unverified/failed/unknown — keeps test-mode auto-exit ≤60 s. */
const UNVERIFIED_TTL_MS = 60 * 1000;

/** Extract the host part of an email address ("hello@x.com" → "x.com"). */
function hostPartOf(email: string | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at === -1 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

// F3 test-mode-sends replaces this stub (HOGSEND_TEST_MODE / HOGSEND_TEST_EMAIL
// env vars + the domain-unverified auto mode are F3-owned).
const TEST_MODE_STUB: TestModeState = {
  active: false,
  reason: null,
  redirectTo: null,
  fromOverride: null,
};

/**
 * Build the cached {@link DomainStatusService} for the active email provider.
 * In-memory cache ONLY (one process = one cache; the API and worker each keep
 * their own) — no Redis dependency.
 */
export function createDomainStatusService(deps: {
  provider: EmailProvider;
  env: typeof envSchema;
  logger: Logger;
}): DomainStatusService {
  const { provider, env, logger } = deps;

  const providerId = provider.meta?.id ?? "resend";
  const supported = Boolean(provider.domains);
  const domain =
    env.EMAIL_DOMAIN ??
    hostPartOf(env.EMAIL_FROM) ??
    hostPartOf(env.RESEND_FROM_EMAIL);

  let cache: { snapshot: EngineDomainStatus; fetchedAt: number } | null = null;
  let inflight: Promise<EngineDomainStatus> | null = null;

  const isFresh = (): boolean => {
    if (!cache) return false;
    const ttl =
      cache.snapshot.status?.state === "verified"
        ? VERIFIED_TTL_MS
        : UNVERIFIED_TTL_MS;
    return Date.now() - cache.fetchedAt < ttl;
  };

  /** Always queries the provider (when supported) and refills the cache. */
  const fetchSnapshot = async (): Promise<EngineDomainStatus> => {
    // No capability / no derivable domain: resolve instantly, NEVER call the
    // provider. status stays null per the pinned EngineDomainStatus contract.
    if (!supported || !domain) {
      const snapshot: EngineDomainStatus = {
        domain,
        providerId,
        supported,
        status: null,
        testMode: { ...TEST_MODE_STUB },
      };
      cache = { snapshot, fetchedAt: Date.now() };
      return snapshot;
    }

    // biome-ignore lint/style/noNonNullAssertion: `supported` guarantees it.
    const capability = provider.domains!;
    const providerStatus = await capability.get(domain);
    const snapshot: EngineDomainStatus = {
      domain,
      providerId,
      supported,
      // Provider doesn't know the domain yet → an explicit not_found status
      // (the Studio Setup view keys its add-domain form off this).
      status: providerStatus ?? {
        domain,
        state: "not_found",
        records: [],
        providerId,
        checkedAt: new Date().toISOString(),
      },
      testMode: { ...TEST_MODE_STUB },
    };
    cache = { snapshot, fetchedAt: Date.now() };
    return snapshot;
  };

  /** Deduped fetch: concurrent callers share one in-flight provider call. */
  const fetchDeduped = (): Promise<EngineDomainStatus> => {
    if (!inflight) {
      inflight = fetchSnapshot().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  };

  return {
    async getStatus(opts?: { refresh?: boolean }): Promise<EngineDomainStatus> {
      if (opts?.refresh) {
        // Bypass + bust: drop the cache so a failed refresh can't leave a
        // stale "fresh" entry, then force a provider round-trip.
        cache = null;
        return fetchDeduped();
      }
      if (isFresh() && cache) return cache.snapshot;
      return fetchDeduped();
    },

    isVerifiedCached(): boolean {
      // FAIL-OPEN: no cache entry, or nothing to verify (unsupported provider /
      // underivable domain) ⇒ treat as verified so a provider outage or a bare
      // deploy can never silently redirect production mail.
      if (!cache || cache.snapshot.status === null) return true;
      return cache.snapshot.status.state === "verified";
    },

    testModeCached(): TestModeState {
      // F3 test-mode-sends replaces this stub with the real cached snapshot.
      return { ...TEST_MODE_STUB };
    },

    refreshIfStale(): void {
      if (isFresh()) return;
      void fetchDeduped().catch((error: unknown) => {
        logger.warn("domain-status refresh failed", {
          domain,
          providerId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
  };
}
