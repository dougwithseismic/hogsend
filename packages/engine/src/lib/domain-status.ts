import type { DomainStatus, EmailProvider } from "@hogsend/core";
import type { env as envSchema } from "../env.js";
import { hostOfFromAddress } from "./from-address.js";
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
/**
 * Back-off TTL after a permission-denied (401/403) refresh failure — e.g. a
 * send-only restricted Resend key that cannot read the domains API. Re-probing
 * every UNVERIFIED_TTL_MS would warn-spam forever and can never succeed until
 * the key changes, so we assume-verified (fail-open) and go quiet for 6 h.
 * An explicit `getStatus({ refresh: true })` (admin route / CLI) still probes.
 */
const PERMISSION_BLOCKED_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Permission-style domains-API failure detection. Matches ONLY the providers'
 * own structured messages — plugin-resend `domains.ts` and plugin-postmark
 * `index.ts` both emit exactly "<Provider> domains API 401: <message>" or
 * "<Provider> domains API request failed with status 403". Deliberately
 * narrow: a bare 401/403/"forbidden" from an intermediary (WAF/proxy/CDN) in
 * front of the provider must NOT match — it stays on the transient path so a
 * blip can never displace a real cached status for the long back-off TTL.
 */
function isPermissionDeniedMessage(message: string): boolean {
  return /\bdomains API (?:request failed with status )?40[13]\b/.test(message);
}

/**
 * Extract the host part of a configured from address ("hello@x.com" or
 * "Name <hello@x.com>" → "x.com") — display-name aware via from-address.ts.
 */
const hostPartOf = hostOfFromAddress;

/** The Resend unverified-domain from-address fallback (so a redirected mail
 * still delivers while the real sending domain isn't verified yet). */
const RESEND_UNVERIFIED_FROM = "onboarding@resend.dev";

/** Inputs to the pure test-mode resolver — single-object-in/result-object-out. */
interface ResolveTestModeDeps {
  /** env.HOGSEND_TEST_MODE. */
  mode: "auto" | "true" | "false";
  /**
   * Whether the sending domain is verified per the CACHE. FAIL-OPEN: a cache
   * miss / provider outage / `!supported` / no domain resolves to `true`
   * (verified assumed), so a provider outage can never silently redirect prod
   * mail (inherits {@link DomainStatusService.isVerifiedCached}).
   */
  verifiedCached: boolean;
  /**
   * Whether `auto` is allowed to ARM at all. `auto` only redirects when an
   * EMAIL_DOMAIN is explicitly configured AND the provider supports domains —
   * a bare deploy (no domain / no capability) keeps today's LIVE behavior, so
   * existing users' sends are never silently redirected.
   */
  autoArmable: boolean;
  providerId: string;
  /** env.HOGSEND_TEST_EMAIL. */
  testEmail?: string;
  /** env.STUDIO_ADMIN_EMAIL (the fallback redirect target). */
  adminEmail?: string;
}

/**
 * Pure resolver for the {@link TestModeState} (PROJECT_SPEC §b, frozen rules):
 * - `active` = `mode === "true"` OR (`mode === "auto"` AND `autoArmable` AND
 *   `!verifiedCached`). `mode === "false"` ⇒ never active.
 * - `reason` = `"env_flag"` when forced by `mode === "true"`, else
 *   `"domain_unverified"` when auto-activated, else `null`.
 * - `redirectTo` = `testEmail ?? adminEmail ?? null`.
 * - `fromOverride` = `onboarding@resend.dev` iff `active && providerId === "resend"`,
 *   else `null` (Postmark et al. get a provider-neutral redirect, no from-override).
 */
function resolveTestMode(deps: ResolveTestModeDeps): TestModeState {
  const {
    mode,
    verifiedCached,
    autoArmable,
    providerId,
    testEmail,
    adminEmail,
  } = deps;

  const forced = mode === "true";
  const autoActive = mode === "auto" && autoArmable && !verifiedCached;
  const active = forced || autoActive;

  const reason: TestModeState["reason"] = forced
    ? "env_flag"
    : autoActive
      ? "domain_unverified"
      : null;

  return {
    active,
    reason,
    redirectTo: active ? (testEmail ?? adminEmail ?? null) : null,
    fromOverride:
      active && providerId === "resend" ? RESEND_UNVERIFIED_FROM : null,
  };
}

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

  // `auto` only ARMS when an EMAIL_DOMAIN is explicitly configured AND the
  // provider has the domains capability. A deploy with no EMAIL_DOMAIN or no
  // capability keeps today's LIVE behavior under `auto` — this is the critical
  // back-compat guard, NOT to be broadened.
  const autoArmable = supported && Boolean(env.EMAIL_DOMAIN);
  const mode = env.HOGSEND_TEST_MODE;

  let cache: { snapshot: EngineDomainStatus; fetchedAt: number } | null = null;
  let inflight: Promise<EngineDomainStatus> | null = null;
  // Permission-denied (401/403) back-off state: blocked extends the cache TTL
  // so the background refresh stops re-probing a key that can never read
  // domains; warned gates the explanatory warn to exactly ONCE per restriction
  // episode (a later successful probe resets both, so a NEW restriction after
  // recovery warns again).
  let permissionBlocked = false;
  let permissionWarned = false;

  const isFresh = (): boolean => {
    if (!cache) return false;
    const ttl = permissionBlocked
      ? PERMISSION_BLOCKED_TTL_MS
      : cache.snapshot.status?.state === "verified"
        ? VERIFIED_TTL_MS
        : UNVERIFIED_TTL_MS;
    return Date.now() - cache.fetchedAt < ttl;
  };

  // FAIL-OPEN verified check against the live cache (shared by the resolver and
  // the public `isVerifiedCached`): no cache entry, or nothing to verify
  // (unsupported provider / underivable domain), ⇒ verified-assumed.
  const verifiedCachedNow = (): boolean => {
    if (!cache || cache.snapshot.status === null) return true;
    return cache.snapshot.status.state === "verified";
  };

  /** Compute the CURRENT live test-mode snapshot off the cache + env. Pure +
   * synchronous; never throws (fail-open inherits from `verifiedCachedNow`). */
  const computeTestMode = (): TestModeState =>
    resolveTestMode({
      mode,
      verifiedCached: verifiedCachedNow(),
      autoArmable,
      providerId,
      testEmail: env.HOGSEND_TEST_EMAIL,
      adminEmail: env.STUDIO_ADMIN_EMAIL,
    });

  // Previous-active flag drives one transition log per flip. Seeded `false` so
  // the FIRST resolution that activates test mode logs the entering banner once
  // (the boot warm-up refresh IS the banner — no separate boot code path).
  let previousActive = false;

  /** Log the entering/exiting transition exactly once per flip of `active`. */
  const logTransition = (
    testMode: TestModeState,
    opts?: { assumedVerified?: boolean },
  ): void => {
    if (testMode.active === previousActive) return;
    if (testMode.active) {
      logger.warn(
        "test mode ACTIVE — domain unverified, redirecting all sends",
        { redirectTo: testMode.redirectTo, reason: testMode.reason },
      );
    } else if (opts?.assumedVerified) {
      // Permission-block fail-open: verification was UNREADABLE, not
      // confirmed — never claim "domain verified" on this path.
      logger.warn(
        "test mode exited — domain status unreadable (permission denied), failing open to LIVE sends",
        { domain },
      );
    } else {
      logger.info("test mode exited — domain verified, sends are LIVE", {
        domain,
      });
    }
    previousActive = testMode.active;
  };

  /**
   * Refill the cache snapshot with the resolved `status`, then compute the live
   * `testMode` off the JUST-written cache and fire the transition log on a flip.
   * Test mode is computed last so it reads the fresh verification state.
   */
  const commitSnapshot = (
    status: DomainStatus | null,
    opts?: { assumedVerified?: boolean },
  ): EngineDomainStatus => {
    // Seed the cache with a placeholder testMode so `computeTestMode` reads the
    // fresh `status`, then overwrite the block with the resolved state.
    const snapshot: EngineDomainStatus = {
      domain,
      providerId,
      supported,
      status,
      testMode: {
        active: false,
        reason: null,
        redirectTo: null,
        fromOverride: null,
      },
    };
    cache = { snapshot, fetchedAt: Date.now() };
    const testMode = computeTestMode();
    snapshot.testMode = testMode;
    logTransition(testMode, opts);
    return snapshot;
  };

  /** Always queries the provider (when supported) and refills the cache. */
  const fetchSnapshot = async (): Promise<EngineDomainStatus> => {
    // No capability / no derivable domain: resolve instantly, NEVER call the
    // provider. status stays null per the pinned EngineDomainStatus contract.
    if (!supported || !domain) {
      return commitSnapshot(null);
    }

    // biome-ignore lint/style/noNonNullAssertion: `supported` guarantees it.
    const capability = provider.domains!;
    let providerStatus: DomainStatus | null;
    try {
      providerStatus = await capability.get(domain);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A permission-denied (401/403) from the provider's domains API — a
      // missing or send-only restricted key — is a CONFIGURATION state, not a
      // server error. Engage the same warn-once + back-off the per-send refresh
      // uses and return a degraded (`status: null`) snapshot, so an explicit
      // getStatus({ refresh }) (admin route, Studio Setup, readiness) resolves
      // to a graceful 200 "not configured" instead of throwing a scary 502.
      // Transient failures (network/5xx) still throw → the caller surfaces 502.
      if (isPermissionDeniedMessage(message)) {
        return markPermissionBlocked(message);
      }
      throw err;
    }
    // The key CAN read domains after all — clear any permission back-off so a
    // key swap recovers immediately and a future restriction warns once again.
    permissionBlocked = false;
    permissionWarned = false;
    return commitSnapshot(
      // Provider doesn't know the domain yet → an explicit not_found status
      // (the Studio Setup view keys its add-domain form off this).
      providerStatus ?? {
        domain,
        state: "not_found",
        records: [],
        providerId,
        checkedAt: new Date().toISOString(),
      },
    );
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

  /**
   * A 401/403 from the provider domains API (e.g. a send-only restricted
   * Resend key): warn ONCE with what it means, then back off under the long
   * {@link PERMISSION_BLOCKED_TTL_MS} so the background refresh stops
   * re-probing + re-warning every UNVERIFIED_TTL_MS. When the cache already
   * holds a REAL snapshot it is KEPT (TTL extended only) — overwriting a
   * genuinely-unverified status with assumed-verified `null` would disarm an
   * armed auto test-mode for 6h off one permission-shaped failure. Only a
   * cold cache commits the assumed-verified `null` snapshot (fail-open
   * verified, the existing contract — production mail is never redirected).
   */
  const markPermissionBlocked = (message: string): EngineDomainStatus => {
    permissionBlocked = true;
    if (!permissionWarned) {
      permissionWarned = true;
      logger.warn(
        "domain-status: the email provider API key cannot read domains " +
          "(permission denied). Keeping the last fetched domain status; " +
          "without one, verification is assumed-verified (fail-open: " +
          "production mail is never redirected) and HOGSEND_TEST_MODE=auto " +
          "cannot arm. Set HOGSEND_TEST_MODE=true to force test-mode " +
          "redirects, or use a full-access API key. Suppressing domain " +
          "checks for 6h.",
        { domain, providerId, error: message },
      );
    }
    if (cache) {
      // Preserve the last real snapshot as the truth; just push its
      // freshness window out to the back-off TTL.
      cache.fetchedAt = Date.now();
      return cache.snapshot;
    }
    // Cold cache: commit the assumed-verified `null` snapshot (fail-open) and
    // hand it back so an explicit getStatus() resolves to a degraded 200
    // instead of throwing.
    return commitSnapshot(null, { assumedVerified: true });
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
      return verifiedCachedNow();
    },

    testModeCached(): TestModeState {
      // Sync, cache-only, never throws. Recomputed off the CURRENT cache so the
      // per-send path always sees the freshest verification state without
      // awaiting (env-flag mode resolves even with a cold cache; auto fails open
      // to LIVE while the cache is empty/unknown).
      return computeTestMode();
    },

    refreshIfStale(): void {
      if (isFresh()) return;
      void fetchDeduped().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        // Permission-denied (401/403) is handled INSIDE fetchSnapshot now
        // (warn-once + long back-off, resolves rather than rejects), so only
        // transient failures (network, 5xx) reach here: warn every stale
        // refresh, short TTL, fail-open verified via the cache.
        logger.warn("domain-status refresh failed", {
          domain,
          providerId,
          error: message,
        });
      });
    },
  };
}
