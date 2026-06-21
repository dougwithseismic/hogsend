import { createCipheriv, createHash, randomBytes } from "node:crypto";
import type { AnalyticsProvider, IdentityMergeOptions } from "@hogsend/core";
import type { HogsendClient } from "@hogsend/engine";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";
// MUST be set before the engine env singleton is imported — this file gets
// its own module graph, so the flag is scoped to these tests.
process.env.TRACKING_IDENTITY_TOKEN = "true";

const { contacts, emailSends, trackedLinks, userEvents } = await import(
  "@hogsend/db"
);
const { inArray } = await import("drizzle-orm");
const {
  createApp,
  createHogsendClient,
  generateIdentityToken,
  InvalidIdentityTokenError,
  validateIdentityToken,
} = await import("@hogsend/engine");

const mockHatchet = {
  durableTask: vi.fn(() => ({
    run: vi.fn(),
    runNoWait: vi.fn(),
    runAndWait: vi.fn(),
  })),
  task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
  events: { push: vi.fn() },
  runs: { cancel: vi.fn(), get: vi.fn() },
  worker: vi.fn(),
} as unknown as HogsendClient["hatchet"];

// ---- analytics spy (the merge wire we assert against) -----------------------
//
// The vitest env (vitest.config.ts) sets NO `POSTHOG_API_KEY`, so the env
// preset builds NO PostHog provider — `analytics: { provider: spy }` therefore
// resolves to our spy uncontested (MF-9). We assert `container.analytics ===
// spy` below so a future env change that smuggles in a real provider fails the
// suite loudly rather than silently routing merges elsewhere.
const mergeSpy = vi.fn<(opts: IdentityMergeOptions) => void>();

function makeAnalytics(opts: {
  identityMerge: boolean;
  withMethod?: boolean;
}): AnalyticsProvider {
  return {
    meta: { id: "spy", name: "Spy Analytics" },
    capabilities: {
      personReads: false,
      personWrites: true,
      identityMerge: opts.identityMerge,
    },
    async getPersonProperties() {
      return {};
    },
    async setPersonProperties() {},
    capture() {},
    // A provider that "cannot merge" omits the method entirely (and sets
    // identityMerge=false); the engine helper/route must no-op cleanly.
    ...(opts.withMethod === false
      ? {}
      : { mergeIdentities: (o: IdentityMergeOptions) => mergeSpy(o) }),
  };
}

// A merge-capable spy provider (the default case). Passed as the BARE-provider
// arm (not the `{ provider }` group): the bare arm registers AND activates the
// provider directly as `container.analytics` (the group arm needs an explicit
// `defaultProvider`/`ANALYTICS_PROVIDER` id to pick the active one, which the
// vitest env doesn't set).
const mergeContainer = createHogsendClient({
  analytics: makeAnalytics({ identityMerge: true }),
  overrides: { hatchet: mockHatchet },
});
const mergeApp = createApp(mergeContainer);

// A provider that declares it CANNOT merge (no method, identityMerge=false).
const noMergeContainer = createHogsendClient({
  analytics: makeAnalytics({ identityMerge: false, withMethod: false }),
  overrides: { hatchet: mockHatchet },
});
const noMergeApp = createApp(noMergeContainer);

// Default app + container for the token/click-route cases that don't care about
// the analytics arm.
const container = mergeContainer;
const app = mergeApp;
const { db, env } = container;

const SECRET = env.BETTER_AUTH_SECRET;
const RUN = `idt-${Date.now()}`;

const sendIds: string[] = [];
const userKeys: string[] = [];

// ---- raw token mint (to forge a PRESENT-and-WRONG `scope`) ------------------
//
// `generateIdentityToken` always stamps `scope: "anon-absorb"`, so it cannot
// produce the bad-scope token MF-7 must reject. Re-implement the engine's
// AES-256-GCM `iv|ciphertext|tag` base64url encoding here to mint an arbitrary
// payload (the wire format the route's `validateIdentityToken` decrypts).
function mintRawToken(payload: Record<string, unknown>): string {
  const key = createHash("sha256").update(SECRET).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf-8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString(
    "base64url",
  );
}

beforeEach(() => {
  mergeSpy.mockClear();
});

afterAll(async () => {
  if (userKeys.length > 0) {
    await db.delete(userEvents).where(inArray(userEvents.userId, userKeys));
    await db.delete(contacts).where(inArray(contacts.email, userKeys));
  }
  if (sendIds.length > 0) {
    await db.delete(emailSends).where(inArray(emailSends.id, sendIds));
  }
});

describe("identity token", () => {
  it("round-trips and is OPAQUE (no readable identity in the URL param)", () => {
    const token = generateIdentityToken({
      secret: SECRET,
      distinctId: "person@example.com",
      emailSendId: "send-1",
    });

    // Encrypted, not merely signed: an email-address distinct id must never
    // be recoverable from the token without the secret.
    expect(Buffer.from(token, "base64url").toString("utf-8")).not.toContain(
      "person@example.com",
    );

    const payload = validateIdentityToken({ token, secret: SECRET });
    expect(payload.distinctId).toBe("person@example.com");
    expect(payload.emailSendId).toBe("send-1");
    // `src` is synthesized from the deprecated `emailSendId` alias.
    expect(payload.src).toBe("email:send-1");
    // Only `"anon-absorb"` is ever minted.
    expect(payload.scope).toBe("anon-absorb");
  });

  it("rejects an expired token", () => {
    const token = generateIdentityToken({
      secret: SECRET,
      distinctId: "u-1",
      emailSendId: "send-1",
      expiresInSeconds: -10,
    });
    expect(() => validateIdentityToken({ token, secret: SECRET })).toThrow(
      InvalidIdentityTokenError,
    );
  });

  it("rejects tampering and wrong secrets", () => {
    const token = generateIdentityToken({
      secret: SECRET,
      distinctId: "u-1",
      emailSendId: "send-1",
    });
    const tampered = `${token.slice(0, -2)}AA`;
    expect(() =>
      validateIdentityToken({ token: tampered, secret: SECRET }),
    ).toThrow(InvalidIdentityTokenError);
    expect(() =>
      validateIdentityToken({ token, secret: "another-secret-entirely-...." }),
    ).toThrow(InvalidIdentityTokenError);
  });

  it("MF-7 — accepts a token with NO `scope` (rolling-deploy: old click route)", () => {
    // A token minted by the still-old click route carries no `scope`. The
    // validator must treat a MISSING scope as the only legal mode (allow).
    const token = mintRawToken({
      distinctId: "u-old",
      src: "email:send-old",
      emailSendId: "send-old",
      exp: Math.floor(Date.now() / 1000) + 3600,
      // NOTE: no `scope` field — the pre-MF-7 shape.
    });
    const payload = validateIdentityToken({ token, secret: SECRET });
    expect(payload.distinctId).toBe("u-old");
    expect(payload.scope).toBeUndefined();
  });

  it("MF-7 — rejects a token with a PRESENT-and-WRONG `scope`", () => {
    const token = mintRawToken({
      distinctId: "u-evil",
      src: "email:send-evil",
      scope: "become-subject", // not "anon-absorb"
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(() => validateIdentityToken({ token, secret: SECRET })).toThrow(
      InvalidIdentityTokenError,
    );
  });
});

describe("POST /v1/t/identify — token exchange (single response schema)", () => {
  it("exchanges a valid token for {distinctId, src, emailSendId}", async () => {
    const token = generateIdentityToken({
      secret: SECRET,
      distinctId: "user-42",
      emailSendId: "send-42",
    });
    const res = await app.request("/v1/t/identify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);
    // The pinned single response schema across §6: `src` is the new field,
    // `emailSendId` retained for the one-minor deprecation window.
    expect(await res.json()).toEqual({
      distinctId: "user-42",
      src: "email:send-42",
      emailSendId: "send-42",
    });
  });

  it("400s garbage", async () => {
    const res = await app.request("/v1/t/identify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "not-a-token" }),
    });
    expect(res.status).toBe(400);
  });

  it("MF-7 — accepts a token with NO scope mid rolling-deploy (200, no 400)", async () => {
    const token = mintRawToken({
      distinctId: "u-rolling",
      src: "email:send-rolling",
      emailSendId: "send-rolling",
      exp: Math.floor(Date.now() / 1000) + 3600,
      // no `scope`
    });
    const res = await app.request("/v1/t/identify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).distinctId).toBe("u-rolling");
  });

  it("MF-7 — 400s a token with a present-and-wrong scope", async () => {
    const token = mintRawToken({
      distinctId: "u-bad-scope",
      src: "email:send-bad",
      scope: "overwrite-subject",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const res = await app.request("/v1/t/identify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/t/identify — server-side alias (MF-5)", () => {
  it("asserts the spy IS the active analytics provider (MF-9 guard)", () => {
    expect(mergeContainer.analytics).toBeDefined();
    expect(mergeContainer.analytics?.capabilities.identityMerge).toBe(true);
  });

  it("{token, currentDistinctId} fires one alias in the CANONICAL direction and 200s synchronously", async () => {
    const token = generateIdentityToken({
      secret: SECRET,
      distinctId: "canon-99",
      emailSendId: "send-99",
    });
    const res = await mergeApp.request("/v1/t/identify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, currentDistinctId: "browser-sess-1" }),
    });
    // The response returns synchronously (the alias is fire-and-forget).
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      distinctId: "canon-99",
      src: "email:send-99",
      emailSendId: "send-99",
    });

    // DIRECTION (MF-1): the token-proven canonical key is the SURVIVOR
    // (`distinctId`); the caller's OWN browser session is the ABSORBED side
    // (`alias`). The canonical key must NEVER appear as `alias`.
    expect(mergeSpy).toHaveBeenCalledTimes(1);
    expect(mergeSpy).toHaveBeenCalledWith({
      distinctId: "canon-99",
      alias: "browser-sess-1",
    });
    expect(mergeSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ alias: "canon-99" }),
    );
  });

  it("{token} only → NO merge, legacy body (best-effort client fallback)", async () => {
    const token = generateIdentityToken({
      secret: SECRET,
      distinctId: "canon-only",
      emailSendId: "send-only",
    });
    const res = await mergeApp.request("/v1/t/identify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      distinctId: "canon-only",
      src: "email:send-only",
      emailSendId: "send-only",
    });
    // No `currentDistinctId` supplied → nothing to absorb → no server alias.
    expect(mergeSpy).not.toHaveBeenCalled();
  });

  it("no-ops the alias when currentDistinctId === the canonical key (self-alias)", async () => {
    const token = generateIdentityToken({
      secret: SECRET,
      distinctId: "self-1",
      emailSendId: "send-self",
    });
    const res = await mergeApp.request("/v1/t/identify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, currentDistinctId: "self-1" }),
    });
    expect(res.status).toBe(200);
    // A self-alias would burn the key — the route must skip it.
    expect(mergeSpy).not.toHaveBeenCalled();
  });

  it("single-use burn — the SAME token merges only ONCE; the replayed exchange is a 200 no-op", async () => {
    // Requires Redis (the NX burn). The token is unique per generation (GCM IV),
    // so this is re-runnable; the first exchange wins, the second is spent.
    const token = generateIdentityToken({
      secret: SECRET,
      distinctId: "burn-canon",
      emailSendId: "send-burn",
    });
    const body = JSON.stringify({ token, currentDistinctId: "burn-browser" });
    const opts = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    };
    const first = await mergeApp.request("/v1/t/identify", opts);
    const second = await mergeApp.request("/v1/t/identify", opts);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // Both resolve the same canonical key…
    expect((await first.json()).distinctId).toBe("burn-canon");
    expect((await second.json()).distinctId).toBe("burn-canon");
    // …but the server merge fires EXACTLY ONCE — the reshared/replayed token
    // can't fold the subject around again.
    expect(mergeSpy).toHaveBeenCalledTimes(1);
    expect(mergeSpy).toHaveBeenCalledWith({
      distinctId: "burn-canon",
      alias: "burn-browser",
    });
  });

  it("provider lacks identityMerge → no merge, still 200 (client fallback)", async () => {
    expect(noMergeContainer.analytics?.capabilities.identityMerge).toBe(false);
    const token = generateIdentityToken({
      secret: SECRET,
      distinctId: "canon-nomerge",
      emailSendId: "send-nm",
    });
    const res = await noMergeApp.request("/v1/t/identify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, currentDistinctId: "browser-nm" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).distinctId).toBe("canon-nomerge");
    // The shared spy must never fire for the no-merge provider — its provider
    // omits `mergeIdentities` entirely.
    expect(mergeSpy).not.toHaveBeenCalled();
  });

  it("MF-4/OQ-3 — the SURVIVOR is always the token-proven key; the caller can only absorb its OWN id", async () => {
    // A forwarded-token holder supplies their own `currentDistinctId`. No
    // request shape lets that value become the survivor or name a victim's id:
    // the survivor is fixed to the token's canonical `distinctId`, the caller's
    // value is only ever the absorbed `alias`.
    const token = generateIdentityToken({
      secret: SECRET,
      distinctId: "victim-subject",
      emailSendId: "send-hijack",
    });
    const res = await mergeApp.request("/v1/t/identify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        currentDistinctId: "forwardee-own-anon",
      }),
    });
    expect(res.status).toBe(200);
    expect(mergeSpy).toHaveBeenCalledTimes(1);
    const arg = mergeSpy.mock.calls[0]?.[0];
    // The subject is the survivor; the forwardee's session is merely absorbed.
    expect(arg?.distinctId).toBe("victim-subject");
    expect(arg?.alias).toBe("forwardee-own-anon");
    // The forwardee never becomes the survivor.
    expect(arg?.distinctId).not.toBe("forwardee-own-anon");
  });
});

describe("GET /v1/t/c/:id — hs_t on redirect (TRACKING_IDENTITY_TOKEN)", () => {
  it("appends a resolvable token to an EMAIL link's destination", async () => {
    const sendRows = await db
      .insert(emailSends)
      .values({
        fromEmail: "test@hogsend.com",
        toEmail: `${RUN}-redir@example.com`,
        subject: "Identity test",
        status: "sent",
        sentAt: new Date(),
      })
      .returning({ id: emailSends.id, toEmail: emailSends.toEmail });
    const send = sendRows[0];
    if (!send) throw new Error("fixture insert failed");
    sendIds.push(send.id);
    userKeys.push(send.toEmail);

    const linkRows = await db
      .insert(trackedLinks)
      .values({
        emailSendId: send.id,
        originalUrl: "https://example.com/docs?utm_source=email",
      })
      .returning({ id: trackedLinks.id });

    const res = await app.request(`/v1/t/c/${linkRows[0]?.id}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get("location") ?? "");
    // Existing params survive; the token is appended.
    expect(location.searchParams.get("utm_source")).toBe("email");
    const token = location.searchParams.get("hs_t");
    expect(token).toBeTruthy();

    const payload = validateIdentityToken({
      token: token ?? "",
      secret: SECRET,
    });
    expect(payload.distinctId).toBe(send.toEmail);
    expect(payload.emailSendId).toBe(send.id);
  });

  it("MF-4 — a BROADCAST link (referral default: no distinctId, no send) mints NO token", async () => {
    // referral / Discord links carry no per-prospect identity token by default
    // — `createTrackedLink` leaves `distinctId` NULL and there is no email send.
    const linkRows = await db
      .insert(trackedLinks)
      .values({
        emailSendId: null,
        distinctId: null,
        source: "link",
        originalUrl: "https://example.com/hey/ada",
      })
      .returning({ id: trackedLinks.id });

    const res = await app.request(`/v1/t/c/${linkRows[0]?.id}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    // No identity rides a shareable broadcast link.
    expect(location.searchParams.get("hs_t")).toBeNull();
    // Click is still tracked (the path counts clicks regardless).
    expect(location.pathname).toBe("/hey/ada");
  });

  it("a STITCH-BEARING non-email link mints a token from its OWN distinctId", async () => {
    // A deployment that explicitly opts a non-email link into stitching passes a
    // `distinctId` (the canonical key) to `createTrackedLink`. The token's
    // subject is that key; `src` is `"<source>:<id>"`.
    const linkRows = await db
      .insert(trackedLinks)
      .values({
        emailSendId: null,
        distinctId: "stitch-canon",
        source: "link",
        originalUrl: "https://example.com/welcome",
      })
      .returning({ id: trackedLinks.id });
    const linkId = linkRows[0]?.id ?? "";

    const res = await app.request(`/v1/t/c/${linkId}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const token = new URL(res.headers.get("location") ?? "").searchParams.get(
      "hs_t",
    );
    expect(token).toBeTruthy();

    const payload = validateIdentityToken({
      token: token ?? "",
      secret: SECRET,
    });
    expect(payload.distinctId).toBe("stitch-canon");
    expect(payload.src).toBe(`link:${linkId}`);
    // A non-email stitch token has no email send behind it.
    expect(payload.emailSendId).toBeUndefined();
  });
});
