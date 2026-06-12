import type { Database } from "@hogsend/db";
import { z } from "zod";
import type { Logger } from "./logger.js";
import {
  getProviderCredential,
  type OAuthCredentialPayload,
  saveProviderCredential,
} from "./provider-credentials.js";

/**
 * The CIMD document URL — doubles as the OAuth `client_id` (PostHog public
 * client, `token_endpoint_auth_method: "none"`). Sent on every refresh.
 *
 * LOCKSTEP (M5): this URL is deliberately re-typed in THREE places — here,
 * the CLI's `POSTHOG_CLIENT_ID` (`packages/cli/src/lib/oauth.ts`), and the
 * `client_id` field inside the hosted CIMD document
 * (`apps/docs/public/.well-known/hogsend-posthog-client.json`). The CLI has
 * no engine dependency, so there is no single importable source of truth;
 * grep all three before changing any of them.
 */
export const HOGSEND_POSTHOG_CLIENT_ID =
  "https://hogsend.com/.well-known/hogsend-posthog-client.json";

/** Refresh when fewer than 60s of access-token life remain. */
export const EXPIRY_SKEW_MS = 60_000;
/** Negative-cache window for "no credential row" — runtime-connect pickup. */
export const ABSENT_RECHECK_MS = 30_000;
/** Minimum gap between failed refresh attempts. */
export const FAILURE_BACKOFF_MS = 60_000;
const REFRESH_TIMEOUT_MS = 10_000;

// The canonical OAuth credential payload (SYNTHESIS §0) — keep textually
// identical to the admin route's PUT body schema
// (`routes/admin/provider-credentials.ts`). Output type matches the store's
// `OAuthCredentialPayload` interface exactly.
export const oauthCredentialPayloadSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
  tokenEndpoint: z.string().url(),
  clientId: z.string().url(),
  scopes: z.array(z.string()).default([]),
  scopedTeams: z.array(z.number().int()).default([]),
  scopedOrganizations: z.array(z.string()).default([]),
});

/** Test/cross-lane seam over the credential store. */
export interface CredentialStore {
  /** Decrypted payload JSON of the (providerId, "oauth") row, or null. */
  load(): Promise<Record<string, unknown> | null>;
  save(payload: OAuthCredentialPayload): Promise<void>;
}

export type CredentialState = "unknown" | "present" | "absent";

export interface TokenManager {
  /**
   * Resolve a live access token, refreshing if necessary. NEVER throws.
   * Returns null when no usable credential exists (absent, malformed, or
   * refresh failed and the old token is hard-expired) — callers degrade.
   */
  getAccessToken(): Promise<string | null>;
  /** Synchronous best-known state — drives `capabilities.personReads`. */
  credentialState(): CredentialState;
  /** Load-only warm-up (no refresh). Fire-and-forget at boot. */
  prime(): Promise<void>;
  /**
   * Drop the in-memory payload and force a refresh attempt on the next
   * getAccessToken (still subject to failure backoff).
   */
  invalidate(): void;
}

interface RefreshResponseBody {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  scoped_teams?: unknown;
  scoped_organizations?: unknown;
  error?: unknown;
}

function defaultStore(db: Database, providerId: string): CredentialStore {
  return {
    load: async () =>
      ((await getProviderCredential(db, providerId, "oauth"))?.payload ??
        null) as Record<string, unknown> | null,
    save: async (payload) => {
      await saveProviderCredential(db, { providerId, payload });
    },
  };
}

/**
 * Per-process OAuth access-token manager: in-memory cache + single-flight
 * refresh against the credential payload's stored `tokenEndpoint`, persisting
 * rotations back through the credential store. One instance per process (API
 * and worker each have their own) — the DB row is the shared truth, so the
 * manager ALWAYS re-loads from the store before refreshing (a sibling process
 * may have refreshed first; adopting its result avoids a cross-process
 * stampede against an endpoint whose rotation semantics are undocumented).
 */
export function createTokenManager(opts: {
  providerId: string;
  db?: Database;
  store?: CredentialStore;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): TokenManager {
  const { providerId, logger } = opts;
  const resolvedStore =
    opts.store ?? (opts.db ? defaultStore(opts.db, providerId) : undefined);
  if (!resolvedStore) {
    throw new Error("createTokenManager requires db or store");
  }
  // Hoisted inner functions can't see the narrowing above — re-bind.
  const store: CredentialStore = resolvedStore;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const now = opts.now ?? Date.now;

  let payload: OAuthCredentialPayload | null = null;
  let absentCheckedAt: number | null = null;
  let lastFailureAt: number | null = null;
  let warnedFailure = false;
  let warnedInvalid = false;
  let forceRefresh = false;
  let inflight: Promise<string | null> | null = null;

  const expiresAtMs = (p: OAuthCredentialPayload) => Date.parse(p.expiresAt);

  // Warn-once: first occurrence per failure streak logs at warn (the message
  // carries the reconnect remediation), repeats drop to debug. Latches reset
  // on the next success so a NEW streak warns again.
  const warnOnce = (kind: "failure" | "invalid", message: string) => {
    const latched = kind === "failure" ? warnedFailure : warnedInvalid;
    if (latched) {
      logger?.debug(message);
      return;
    }
    logger?.warn(message);
    if (kind === "failure") warnedFailure = true;
    else warnedInvalid = true;
  };

  const errMsg = (err: unknown) =>
    err instanceof Error ? err.message : String(err);

  async function refresh(
    old: OAuthCredentialPayload,
    t: number,
  ): Promise<string | null> {
    let detail: string;
    try {
      const response = await fetchImpl(old.tokenEndpoint, {
        method: "POST",
        headers: {
          // No Authorization header — public client; client_id in the body.
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: old.refreshToken,
          client_id: old.clientId,
        }).toString(),
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      });

      if (response.ok) {
        const body = (await response.json()) as RefreshResponseBody;
        if (
          typeof body.access_token === "string" &&
          typeof body.expires_in === "number"
        ) {
          const next: OAuthCredentialPayload = {
            ...old,
            accessToken: body.access_token,
            // ROTATION RULE: PostHog's refresh-token rotation behavior is
            // undocumented — always store a returned refresh token, KEEP the
            // old one when the response omits it.
            refreshToken:
              typeof body.refresh_token === "string"
                ? body.refresh_token
                : old.refreshToken,
            expiresAt: new Date(t + body.expires_in * 1000).toISOString(),
            scopes:
              typeof body.scope === "string"
                ? body.scope.split(" ")
                : old.scopes,
            scopedTeams: Array.isArray(body.scoped_teams)
              ? (body.scoped_teams as number[])
              : old.scopedTeams,
            scopedOrganizations: Array.isArray(body.scoped_organizations)
              ? (body.scoped_organizations as string[])
              : old.scopedOrganizations,
          };
          try {
            await store.save(next);
          } catch (err) {
            // Persistence hiccup must not kill the send path — adopt the
            // refreshed token in memory; a process restart re-refreshes.
            logger?.warn(
              `${providerId} oauth credential save failed after refresh ` +
                `(token kept in memory): ${errMsg(err)}`,
            );
          }
          payload = next;
          lastFailureAt = null;
          warnedFailure = false;
          forceRefresh = false;
          return next.accessToken;
        }
        detail = "unparseable token response";
      } else {
        detail = `HTTP ${response.status}`;
        try {
          const errBody = (await response.json()) as RefreshResponseBody;
          if (typeof errBody.error === "string") detail = errBody.error;
        } catch {
          // keep the HTTP status detail
        }
      }
    } catch (err) {
      detail = errMsg(err);
    }

    lastFailureAt = t;
    forceRefresh = false;
    warnOnce(
      "failure",
      `${providerId} oauth token refresh failed (${detail}) — analytics ` +
        "reads degrade (personal key fallback or disabled); run " +
        `\`hogsend connect ${providerId}\` to reconnect`,
    );
    // Inside the skew window the old token is technically still live.
    return expiresAtMs(old) > t ? old.accessToken : null;
  }

  async function run(): Promise<string | null> {
    const t = now();

    // 1. Fresh in-memory token → fast path, no IO.
    if (!forceRefresh && payload && expiresAtMs(payload) - EXPIRY_SKEW_MS > t) {
      return payload.accessToken;
    }

    // 2. Known-absent within the negative-cache window → cheap null.
    if (
      !payload &&
      absentCheckedAt !== null &&
      t - absentCheckedAt < ABSENT_RECHECK_MS
    ) {
      return null;
    }

    // 3. (Re)load from the store. ALWAYS re-load before refreshing — another
    //    process (API vs worker) may have already refreshed; adopting its row
    //    avoids a cross-process refresh stampede.
    let raw: Record<string, unknown> | null;
    try {
      raw = await store.load();
    } catch (err) {
      // Surfaces ProviderCredentialDecryptError.message verbatim — it
      // carries the reconnect remediation.
      warnOnce(
        "invalid",
        `${providerId} oauth credential load failed: ${errMsg(err)}`,
      );
      payload = null;
      absentCheckedAt = t;
      return null;
    }
    if (raw === null) {
      // Absent is NORMAL (provider not connected) — no warn.
      payload = null;
      absentCheckedAt = t;
      return null;
    }
    const parsed = oauthCredentialPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      warnOnce(
        "invalid",
        `${providerId} oauth credential payload is malformed — re-run ` +
          `\`hogsend connect ${providerId}\``,
      );
      payload = null;
      absentCheckedAt = t;
      return null;
    }
    payload = parsed.data;
    absentCheckedAt = null;
    warnedInvalid = false;

    // 4. Reloaded token already fresh (e.g. the other process refreshed).
    if (!forceRefresh && expiresAtMs(payload) - EXPIRY_SKEW_MS > t) {
      return payload.accessToken;
    }

    // 5. Failure backoff: don't hammer the endpoint. Inside the skew window
    //    the old token is technically still live — return it.
    if (lastFailureAt !== null && t - lastFailureAt < FAILURE_BACKOFF_MS) {
      return expiresAtMs(payload) > t ? payload.accessToken : null;
    }

    // 6. Refresh.
    return refresh(payload, t);
  }

  return {
    getAccessToken() {
      if (inflight) return inflight;
      inflight = run().finally(() => {
        inflight = null;
      });
      return inflight;
    },

    credentialState() {
      return payload
        ? "present"
        : absentCheckedAt !== null
          ? "absent"
          : "unknown";
    },

    // Load-only by design: a refreshing prime would make the API and worker
    // race a simultaneous refresh on every deploy. The first real read pays
    // the refresh; step 3's reload-before-refresh heals the residual race.
    async prime() {
      if (payload || absentCheckedAt !== null) return;
      try {
        const raw = await store.load();
        if (raw === null) {
          absentCheckedAt = now();
          return;
        }
        const parsed = oauthCredentialPayloadSchema.safeParse(raw);
        if (parsed.success) payload = parsed.data;
        else absentCheckedAt = now();
      } catch {
        absentCheckedAt = now();
      }
    },

    invalidate() {
      payload = null;
      absentCheckedAt = null;
      forceRefresh = true;
    },
  };
}
