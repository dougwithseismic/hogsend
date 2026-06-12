import { createHash, randomBytes } from "node:crypto";

/**
 * OAuth 2.0 primitives for `hogsend connect posthog`: PKCE (S256, RFC 7636),
 * RFC 8414 authorization-server discovery, the authorize-URL builder, and the
 * form-encoded public-client code exchange. Pure + injectable (`fetchImpl`)
 * so everything is unit-testable without a live PostHog.
 */

/**
 * The CIMD document URL — doubles as the OAuth `client_id` (PostHog public
 * client, `token_endpoint_auth_method: "none"`).
 *
 * LOCKSTEP (M5): this URL is deliberately re-typed in THREE places — here,
 * the engine's `HOGSEND_POSTHOG_CLIENT_ID`
 * (`packages/engine/src/lib/oauth-token-manager.ts`), and the `client_id`
 * field inside the hosted CIMD document
 * (`apps/docs/public/.well-known/hogsend-posthog-client.json`). The CLI has
 * no engine dependency, so there is no single importable source of truth;
 * grep all three before changing any of them.
 */
export const POSTHOG_CLIENT_ID =
  "https://hogsend.com/.well-known/hogsend-posthog-client.json";

/**
 * LOCKSTEP (M5): must match the `scope` field of the hosted CIMD document
 * (`apps/docs/public/.well-known/hogsend-posthog-client.json`).
 */
export const POSTHOG_SCOPES =
  "person:read person:write project:read hog_function:write";

/**
 * LOCKSTEP (M5): the CIMD document's `redirect_uris` list EXACTLY
 * `http://127.0.0.1:{8423,8424,8425}/callback` — these constants and the
 * hosted JSON (`apps/docs/public/.well-known/hogsend-posthog-client.json`)
 * must stay in lockstep, or PostHog rejects the redirect at authorize time.
 */
export const LOOPBACK_PORTS = [8423, 8424, 8425] as const;
export const CALLBACK_PATH = "/callback";
export const CALLBACK_TIMEOUT_MS = 300_000; // 5 min

/**
 * Consent-scope refinement (verified: the authorize endpoint accepts a
 * required_access_level param; "team" = least privilege). If the live consent
 * page rejects the param during e2e verification, flip to undefined — the
 * flow must not depend on it.
 */
export const REQUIRED_ACCESS_LEVEL: string | undefined = "team";

const DISCOVERY_TIMEOUT_MS = 10_000;

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

/**
 * base64url(sha256(ascii verifier)) — exported separately for the RFC 7636
 * appendix B vector test.
 */
export function computeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/**
 * verifier = base64url(crypto.randomBytes(32)) → 43 chars, RFC 7636 §4.1
 * charset (no padding — Node's base64url omits `=`).
 */
export function generatePkce(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: computeChallenge(verifier), method: "S256" };
}

/** base64url(crypto.randomBytes(16)) — high-entropy CSRF state. */
export function generateState(): string {
  return randomBytes(16).toString("base64url");
}

export interface OAuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  [k: string]: unknown; // passthrough
}

export type DiscoveryResult =
  | { status: "ok"; metadata: OAuthServerMetadata }
  | { status: "unsupported" } // HTTP 404 or 410
  | { status: "error"; message: string }; // transport / non-JSON / missing endpoints

/**
 * RFC 8414 discovery against the instance's own private host —
 * `GET {privateHost}/.well-known/oauth-authorization-server`. Never hardcode
 * `oauth.posthog.com`; per-region servers are discovered from the host.
 * Self-hosted builds without OAuth 404 here → `unsupported` (clean
 * personal-API-key fallback). Never throws.
 */
export async function discoverOAuthServer(opts: {
  /** No trailing slash. */
  privateHost: string;
  fetchImpl?: typeof fetch;
}): Promise<DiscoveryResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${opts.privateHost}/.well-known/oauth-authorization-server`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    return { status: "error", message: `OAuth discovery failed: ${msg}` };
  }

  if (res.status === 404 || res.status === 410) {
    return { status: "unsupported" };
  }
  if (!res.ok) {
    return {
      status: "error",
      message: `OAuth discovery failed (HTTP ${res.status})`,
    };
  }

  let doc: unknown;
  try {
    doc = await res.json();
  } catch {
    return {
      status: "error",
      message: "malformed discovery document (not JSON)",
    };
  }

  if (
    typeof doc !== "object" ||
    doc === null ||
    typeof (doc as Record<string, unknown>).issuer !== "string" ||
    typeof (doc as Record<string, unknown>).authorization_endpoint !==
      "string" ||
    typeof (doc as Record<string, unknown>).token_endpoint !== "string"
  ) {
    return {
      status: "error",
      message:
        "malformed discovery document (missing issuer / " +
        "authorization_endpoint / token_endpoint)",
    };
  }

  return { status: "ok", metadata: doc as OAuthServerMetadata };
}

/** Build the user-facing authorize URL (PKCE S256, public client). */
export function buildAuthorizeUrl(opts: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  pkce: PkcePair;
  requiredAccessLevel?: string;
}): string {
  const url = new URL(opts.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("scope", opts.scope);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.pkce.challenge);
  url.searchParams.set("code_challenge_method", opts.pkce.method);
  if (opts.requiredAccessLevel !== undefined) {
    url.searchParams.set("required_access_level", opts.requiredAccessLevel);
  }
  return url.toString();
}

export interface TokenResponse {
  access_token: string;
  /** REQUIRED here — `exchangeCode` throws when a 200 omits it. */
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
  id_token?: string;
  scoped_teams?: number[];
  /** PostHog org ids are UUID strings (SYNTHESIS §0). */
  scoped_organizations?: string[];
}

/**
 * Public-client authorization-code exchange: form-encoded POST, NO
 * Authorization header, NO client_secret. The error message NEVER includes
 * the code or verifier.
 */
export async function exchangeCode(opts: {
  tokenEndpoint: string;
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<TokenResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;

  const res = await fetchImpl(opts.tokenEndpoint, {
    method: "POST",
    headers: {
      // URLSearchParams sets this automatically; explicit for clarity.
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: opts.code,
      redirect_uri: opts.redirectUri,
      client_id: opts.clientId,
      code_verifier: opts.codeVerifier,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = text;
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as Record<string, unknown>).error === "string"
      ) {
        detail = (parsed as { error: string }).error;
      }
    } catch {
      // non-JSON body — keep the raw text
    }
    throw new Error(
      `token exchange failed (${res.status})${detail ? `: ${detail}` : ""}`,
    );
  }

  const json = (await res.json()) as Record<string, unknown>;
  if (typeof json.access_token !== "string" || json.access_token === "") {
    throw new Error("token response missing access_token");
  }
  if (typeof json.refresh_token !== "string" || json.refresh_token === "") {
    throw new Error(
      "token response missing refresh_token — cannot store a long-lived " +
        "credential",
    );
  }
  return json as unknown as TokenResponse;
}
