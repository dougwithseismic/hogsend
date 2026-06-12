import { describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl,
  computeChallenge,
  discoverOAuthServer,
  exchangeCode,
  generatePkce,
  generateState,
  POSTHOG_CLIENT_ID,
  POSTHOG_SCOPES,
} from "../lib/oauth.js";

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/** Minimal recording fetch fake (mirrors hatchet-token.test.ts's pattern). */
function fakeFetch(
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return respond(url, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("computeChallenge", () => {
  it("matches the RFC 7636 appendix B vector", () => {
    expect(
      computeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("generatePkce", () => {
  it("emits a 43-char base64url verifier with a matching S256 challenge", () => {
    const pkce = generatePkce();
    expect(pkce.verifier).toHaveLength(43);
    expect(pkce.verifier).toMatch(BASE64URL_RE);
    expect(pkce.verifier).not.toContain("=");
    expect(pkce.challenge).toBe(computeChallenge(pkce.verifier));
    expect(pkce.method).toBe("S256");
  });

  it("two calls differ", () => {
    expect(generatePkce().verifier).not.toBe(generatePkce().verifier);
  });
});

describe("generateState", () => {
  it("is unique and base64url across 100 calls", () => {
    const states = Array.from({ length: 100 }, () => generateState());
    expect(new Set(states).size).toBe(100);
    for (const state of states) {
      expect(state).toMatch(BASE64URL_RE);
    }
  });
});

describe("buildAuthorizeUrl", () => {
  const base = {
    authorizationEndpoint: "https://eu.posthog.com/oauth/authorize/",
    clientId: POSTHOG_CLIENT_ID,
    redirectUri: "http://127.0.0.1:8423/callback",
    scope: POSTHOG_SCOPES,
    state: "st4te",
    pkce: {
      verifier: "v".repeat(43),
      challenge: "ch4llenge",
      method: "S256" as const,
    },
  };

  it("sets every OAuth param and never a client_secret", () => {
    const url = new URL(
      buildAuthorizeUrl({ ...base, requiredAccessLevel: "team" }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://eu.posthog.com/oauth/authorize/",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(POSTHOG_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(base.redirectUri);
    expect(url.searchParams.get("scope")).toBe(POSTHOG_SCOPES);
    expect(url.searchParams.get("state")).toBe("st4te");
    expect(url.searchParams.get("code_challenge")).toBe("ch4llenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("required_access_level")).toBe("team");
    expect(url.searchParams.has("client_secret")).toBe(false);
  });

  it("omits required_access_level when not provided", () => {
    const url = new URL(buildAuthorizeUrl(base));
    expect(url.searchParams.has("required_access_level")).toBe(false);
  });
});

describe("discoverOAuthServer", () => {
  const DOC = {
    issuer: "https://eu.posthog.com",
    authorization_endpoint: "https://eu.posthog.com/oauth/authorize/",
    token_endpoint: "https://eu.posthog.com/oauth/token/",
  };

  it("requests the RFC 8414 well-known path and returns ok metadata", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(DOC));
    const result = await discoverOAuthServer({
      privateHost: "https://eu.posthog.com",
      fetchImpl,
    });
    expect(calls[0]?.url).toBe(
      "https://eu.posthog.com/.well-known/oauth-authorization-server",
    );
    expect(result).toEqual({ status: "ok", metadata: DOC });
  });

  it("maps 404 and 410 to unsupported", async () => {
    for (const status of [404, 410]) {
      const { fetchImpl } = fakeFetch(() => new Response("nope", { status }));
      const result = await discoverOAuthServer({
        privateHost: "https://ph.selfhosted.example",
        fetchImpl,
      });
      expect(result).toEqual({ status: "unsupported" });
    }
  });

  it("flags a 200 missing token_endpoint as malformed", async () => {
    const { fetchImpl } = fakeFetch(() =>
      json({
        issuer: DOC.issuer,
        authorization_endpoint: DOC.authorization_endpoint,
      }),
    );
    const result = await discoverOAuthServer({
      privateHost: "https://eu.posthog.com",
      fetchImpl,
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("malformed");
    }
  });

  it("never throws on transport failure", async () => {
    const fetchImpl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    const result = await discoverOAuthServer({
      privateHost: "https://eu.posthog.com",
      fetchImpl,
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("ENOTFOUND");
    }
  });
});

describe("exchangeCode", () => {
  const OPTS = {
    tokenEndpoint: "https://eu.posthog.com/oauth/token/",
    clientId: POSTHOG_CLIENT_ID,
    code: "auth-code-abc",
    codeVerifier: "verifier-xyz",
    redirectUri: "http://127.0.0.1:8423/callback",
  };
  const TOKENS = {
    access_token: "pha_fixture",
    refresh_token: "phr_fixture",
    token_type: "Bearer",
    expires_in: 36_000,
    scope: POSTHOG_SCOPES,
    scoped_teams: [123],
    scoped_organizations: [],
  };

  it("POSTs exactly the five form params with no client_secret / auth header", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(TOKENS));
    const result = await exchangeCode({ ...OPTS, fetchImpl });

    const call = calls[0];
    expect(call?.init?.method).toBe("POST");
    const headers = call?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();

    const body = new URLSearchParams(String(call?.init?.body));
    expect(Object.fromEntries(body.entries())).toEqual({
      grant_type: "authorization_code",
      code: "auth-code-abc",
      redirect_uri: OPTS.redirectUri,
      client_id: POSTHOG_CLIENT_ID,
      code_verifier: "verifier-xyz",
    });
    expect(body.has("client_secret")).toBe(false);

    expect(result).toEqual(TOKENS);
  });

  it("throws with the status (never the code/verifier) on a 400", async () => {
    const { fetchImpl } = fakeFetch(() =>
      json({ error: "invalid_grant" }, 400),
    );
    await expect(exchangeCode({ ...OPTS, fetchImpl })).rejects.toSatisfy(
      (err: unknown) => {
        const message = (err as Error).message;
        expect(message).toContain("400");
        expect(message).toContain("invalid_grant");
        expect(message).not.toContain("auth-code-abc");
        expect(message).not.toContain("verifier-xyz");
        return true;
      },
    );
  });

  it("throws when a 200 omits refresh_token", async () => {
    const { refresh_token: _omitted, ...withoutRefresh } = TOKENS;
    const { fetchImpl } = fakeFetch(() => json(withoutRefresh));
    await expect(exchangeCode({ ...OPTS, fetchImpl })).rejects.toThrow(
      /missing refresh_token/,
    );
  });
});
