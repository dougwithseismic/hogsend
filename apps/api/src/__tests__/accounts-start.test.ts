import { describe, expect, it } from "vitest";
import { fakeAccountLink } from "./account-link-fakes.js";

// Same real test DB the engine singletons + the route container read.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const {
  createApp,
  createHogsendClient,
  mintAccountLinkUrl,
  signConnectorState,
  verifyConnectorState,
} = await import("@hogsend/engine");
const { Redis } = await import("ioredis");

const SECRET = "test-secret-for-vitest-minimum-32-characters-long";
const API_ORIGIN = "http://localhost:3002";
const ALLOWED = "https://play.example.com";

/**
 * PRD 07 T5 — `GET /v1/accounts/:provider/start`.
 *
 * Every request carries a UNIQUE `x-forwarded-for`: the throttle is a real
 * fixed-window counter against the real Redis, so a shared bucket would make
 * these tests order-dependent and the cap test would poison its neighbours.
 */
const RUN = `alstart-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
let ipSeq = 0;
const freshIp = () => `${RUN}-${ipSeq++}`;

const steam = fakeAccountLink({ id: "steam", name: "Steam" });
const twitch = fakeAccountLink({
  id: "twitch",
  name: "Twitch",
  pkce: true,
  tokens: true,
});

const container = createHogsendClient({
  accountLinks: {
    providers: [steam, twitch],
    allowedOrigins: [ALLOWED],
  },
});
const app = createApp(container);

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6380");

function start(path: string, headers: Record<string, string> = {}) {
  return app.request(path, {
    headers: { "x-forwarded-for": freshIp(), ...headers },
  });
}

/** The state token the provider was handed on its authorize URL. */
function stateFromLocation(location: string): string {
  const state = new URL(location).searchParams.get("state");
  expect(state).toBeTruthy();
  return state as string;
}

describe("GET /v1/accounts/:provider/start — preconditions", () => {
  it("404s an unregistered provider and mints no state", async () => {
    const before = steam.calls.authorizeUrl.length;
    const res = await start("/v1/accounts/nope/start");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown_provider" });
    expect(steam.calls.authorizeUrl.length).toBe(before);
  });

  it("GET /v1/accounts/steam/start with no Authorization header is neither 401 nor 403", async () => {
    // Asserting the ACTUAL success status, not merely "not 401". PRD 09's
    // blanket param guard would answer 403 (from the scope check) rather than
    // 401, so a "not 401" assertion would ship the broken route green.
    const res = await start("/v1/accounts/steam/start");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(
      "https://provider.test/steam/authorize",
    );
  });

  it("429s past the per-IP cap and mints no state", async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await app.request("/v1/accounts/steam/start", {
        headers: { "x-forwarded-for": ip },
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 302)).toBe(true);
    expect(statuses[20]).toBe(429);

    const before = steam.calls.authorizeUrl.length;
    const over = await app.request("/v1/accounts/steam/start", {
      headers: { "x-forwarded-for": ip },
    });
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "rate_limited" });
    expect(steam.calls.authorizeUrl.length).toBe(before);
  });
});

describe("GET /v1/accounts/:provider/start — return_to", () => {
  it("400s a return_to whose origin is not on the allowlist", async () => {
    const before = steam.calls.authorizeUrl.length;
    const res = await start(
      `/v1/accounts/steam/start?return_to=${encodeURIComponent("https://evil.test/thanks")}`,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "return_to_not_allowed" });
    expect(steam.calls.authorizeUrl.length).toBe(before);
  });

  it("400s a return_to that only PREFIX-matches an allowed origin", async () => {
    // `startsWith` would wave this through; the check parses the origin.
    const res = await start(
      `/v1/accounts/steam/start?return_to=${encodeURIComponent("https://play.example.com.evil.test/x")}`,
    );
    expect(res.status).toBe(400);
  });

  it("seals an allowlisted return_to into the state", async () => {
    const res = await start(
      `/v1/accounts/steam/start?return_to=${encodeURIComponent(`${ALLOWED}/done`)}`,
    );
    expect(res.status).toBe(302);
    const state = stateFromLocation(res.headers.get("location") as string);
    const check = verifyConnectorState(state, SECRET);
    expect(check.intent?.returnTo).toBe(`${ALLOWED}/done`);
  });
});

describe("GET /v1/accounts/:provider/start — cold binding", () => {
  it("a cold start with no anonymous_id mints one and sets it as a cookie", async () => {
    const res = await start("/v1/accounts/steam/start");
    expect(res.status).toBe(302);

    const cookie = res.headers.get("set-cookie");
    expect(cookie).toBeTruthy();
    const value = decodeURIComponent(
      /hs_anon_id=([^;]+)/.exec(cookie as string)?.[1] ?? "",
    );
    expect(value.length).toBeGreaterThan(10);

    const state = stateFromLocation(res.headers.get("location") as string);
    const check = verifyConnectorState(state, SECRET);
    expect(check.valid).toBe(true);
    expect(check.intent?.purpose).toBe("account_link");
    expect(check.intent?.providerId).toBe("steam");
    // The sealed key and the cookie are the SAME key, or the browser carries
    // one identity and the link commits under another.
    expect(check.intent?.anonymousId).toBe(value);
    expect(check.intent?.contactId).toBeUndefined();
  });

  it("uses a supplied anonymous_id and sets no cookie", async () => {
    const res = await start(
      `/v1/accounts/steam/start?anonymous_id=${RUN}-supplied`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toBeNull();
    const check = verifyConnectorState(
      stateFromLocation(res.headers.get("location") as string),
      SECRET,
    );
    expect(check.intent?.anonymousId).toBe(`${RUN}-supplied`);
  });
});

describe("GET /v1/accounts/:provider/start — warm binding", () => {
  const contactId = "11111111-2222-3333-4444-555555555555";
  const warmToken = (over: Record<string, unknown> = {}, ttl = 900) =>
    signConnectorState(
      {
        purpose: "account_link",
        providerId: "steam",
        contactId,
        nonce: `warm-${crypto.randomUUID()}`,
        ...over,
      },
      SECRET,
      ttl,
    );

  it("carries a verified ?t= binding through as the sealed contactId", async () => {
    const res = await start(
      `/v1/accounts/steam/start?t=${encodeURIComponent(warmToken())}`,
    );
    expect(res.status).toBe(302);
    const check = verifyConnectorState(
      stateFromLocation(res.headers.get("location") as string),
      SECRET,
    );
    expect(check.intent?.contactId).toBe(contactId);
    expect(check.intent?.anonymousId).toBeUndefined();
    // A FRESH nonce per attempt — re-using the minted one would make the burn
    // at the callback consume a nonce the mint URL could hand out twice.
    expect(check.intent?.nonce).toBeTruthy();
  });

  it("400s a tampered ?t= and does NOT downgrade it to a cold link", async () => {
    const token = warmToken();
    const [payload, sig] = token.split(".");
    const decoded = JSON.parse(
      Buffer.from(payload as string, "base64url").toString("utf8"),
    );
    decoded.contactId = "99999999-9999-9999-9999-999999999999";
    const forged = `${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${sig}`;

    const before = steam.calls.authorizeUrl.length;
    const res = await start(
      `/v1/accounts/steam/start?t=${encodeURIComponent(forged)}`,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_token" });
    // A silent downgrade would have produced a 302 with an anonymous binding.
    expect(steam.calls.authorizeUrl.length).toBe(before);
  });

  it("400s an expired ?t=", async () => {
    const res = await start(
      `/v1/accounts/steam/start?t=${encodeURIComponent(warmToken({}, -1))}`,
    );
    expect(res.status).toBe(400);
  });

  it("400s a ?t= minted for a DIFFERENT provider", async () => {
    const res = await start(
      `/v1/accounts/twitch/start?t=${encodeURIComponent(warmToken())}`,
    );
    expect(res.status).toBe(400);
  });

  it("400s a ?t= whose purpose is member_link", async () => {
    const token = signConnectorState(
      {
        purpose: "member_link",
        connectorId: "discord",
        contactId,
        nonce: `member-${crypto.randomUUID()}`,
      },
      SECRET,
      900,
    );
    const res = await start(
      `/v1/accounts/steam/start?t=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/accounts/:provider/start — PKCE", () => {
  it("sends an S256 challenge and takes Redis custody of the verifier", async () => {
    const res = await start("/v1/accounts/twitch/start");
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get("location") as string);
    const challenge = location.searchParams.get("code_challenge");
    expect(challenge).toBeTruthy();
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");

    const state = stateFromLocation(location.toString());
    const nonce = verifyConnectorState(state, SECRET).intent?.nonce as string;
    const stored = await redis.get(`account_link:pkce:${nonce}`);
    expect(stored).toBeTruthy();

    // The VERIFIER never travels: not in the state, not on the redirect.
    expect(state).not.toContain(stored as string);
    expect(location.toString()).not.toContain(stored as string);
    expect(challenge).not.toBe(stored);
  });

  it("skips the PKCE mint entirely for a provider that does not declare it", async () => {
    const res = await start("/v1/accounts/steam/start");
    const state = stateFromLocation(res.headers.get("location") as string);
    const nonce = verifyConnectorState(state, SECRET).intent?.nonce as string;

    expect(await redis.get(`account_link:pkce:${nonce}`)).toBeNull();
    expect(
      new URL(res.headers.get("location") as string).searchParams.get(
        "code_challenge",
      ),
    ).toBeNull();
    expect(steam.calls.authorizeUrl.at(-1)?.codeChallenge).toBeUndefined();
  });
});

describe("mintAccountLinkUrl", () => {
  it("returns an API_PUBLIC_URL-origin /start URL carrying a verifiable state", async () => {
    const contactId = "11111111-2222-3333-4444-555555555555";
    const url = new URL(mintAccountLinkUrl({ provider: "steam", contactId }));

    // PRD 13 derives its postMessage expectedOrigin from exactly this: a
    // provider authorize URL here would make the embed drop every success
    // message and time out while the link had committed server-side.
    expect(url.origin).toBe(new URL(API_ORIGIN).origin);
    expect(url.pathname).toBe("/v1/accounts/steam/start");

    const check = verifyConnectorState(
      url.searchParams.get("t") as string,
      SECRET,
    );
    expect(check.valid).toBe(true);
    expect(check.intent?.purpose).toBe("account_link");
    expect(check.intent?.providerId).toBe("steam");
    expect(check.intent?.contactId).toBe(contactId);
  });

  it("never returns a provider authorize URL", async () => {
    const url = mintAccountLinkUrl({
      provider: "twitch",
      contactId: "11111111-2222-3333-4444-555555555555",
    });
    expect(url).not.toContain("provider.test");
    expect(url).not.toContain("id.twitch.tv");
    expect(url).not.toContain("steamcommunity.com");
  });

  it("refuses a returnTo that is not on the allowlist", () => {
    expect(() =>
      mintAccountLinkUrl({
        provider: "steam",
        contactId: "11111111-2222-3333-4444-555555555555",
        returnTo: "https://evil.test/x",
        allowedOrigins: [ALLOWED],
      }),
    ).toThrow(/not on the account-link origin allowlist/);
  });

  it("seals an allowlisted returnTo", () => {
    const url = new URL(
      mintAccountLinkUrl({
        provider: "steam",
        contactId: "11111111-2222-3333-4444-555555555555",
        returnTo: `${ALLOWED}/done`,
        allowedOrigins: [ALLOWED],
      }),
    );
    const check = verifyConnectorState(
      url.searchParams.get("t") as string,
      SECRET,
    );
    expect(check.intent?.returnTo).toBe(`${ALLOWED}/done`);
  });

  it("the minted URL is accepted by /start as a WARM binding", async () => {
    const contactId = "11111111-2222-3333-4444-555555555555";
    const minted = new URL(
      mintAccountLinkUrl({ provider: "steam", contactId }),
    );
    const res = await start(`${minted.pathname}${minted.search}`);
    expect(res.status).toBe(302);
    const check = verifyConnectorState(
      stateFromLocation(res.headers.get("location") as string),
      SECRET,
    );
    expect(check.intent?.contactId).toBe(contactId);
  });
});
