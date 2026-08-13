import type { AfterLinkContext, BeforeLinkContext } from "@hogsend/core";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeAccountLink } from "./account-link-fakes.js";

// Same real test DB the engine singletons + the route container read.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, createDatabase, linkedAccounts } = await import(
  "@hogsend/db"
);
const { and, eq, isNull, like } = await import("drizzle-orm");
const { createApp, createHogsendClient, signConnectorState } = await import(
  "@hogsend/engine"
);

const SECRET = "test-secret-for-vitest-minimum-32-characters-long";
const ALLOWED = "https://play.example.com";

/**
 * PRD 07 T6 — `GET /v1/accounts/:provider/callback`, named for the attacks it
 * closes. This is the ONLY route in the feature that may MOVE a link, so every
 * case below is either "an attacker cannot" or "the legitimate flow still can".
 *
 * Every row carries the per-run prefix and `afterAll` deletes exactly that
 * namespace. Counts are namespace-scoped, never whole-table: this file runs in
 * parallel with ~190 others against one Postgres.
 */
const RUN = `alcb-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
let seq = 0;
const uid = (label: string) => `${RUN}-${label}-${seq++}`;

const { db, client } = createDatabase({
  url: process.env.DATABASE_URL as string,
});

/** Mutable hook holders — one container per file, many hook postures. */
const hooks: {
  before?: (ctx: BeforeLinkContext) => unknown;
  after?: (ctx: AfterLinkContext) => unknown;
} = {};
const afterLinkCalls: AfterLinkContext[] = [];
const beforeLinkCalls: BeforeLinkContext[] = [];

const steam = fakeAccountLink({ id: "steam", name: "Steam" });
const twitch = fakeAccountLink({ id: "twitch", name: "Twitch", pkce: true });
/**
 * The REAL preset, registered under its own id so the two hosted routes are
 * driven end to end by production provider code — with `globalThis.fetch`
 * stubbed, so still zero network and zero credentials. It is the only thing
 * that proves the callback presents the SAME `openid.return_to` it minted;
 * a Fake cannot, because a Fake does not check.
 */
const { steamOpenIdLink, STEAM_OPENID_ENDPOINT } = await import(
  "@hogsend/core"
);
const realSteam = steamOpenIdLink({
  meta: { id: "steamreal", name: "Steam Real" },
  realm: "http://localhost:3002",
});

const container = createHogsendClient({
  accountLinks: {
    providers: [steam, twitch, realSteam],
    allowedOrigins: [ALLOWED],
    hooks: {
      beforeLink(ctx) {
        beforeLinkCalls.push(ctx);
        return hooks.before?.(ctx) as never;
      },
      afterLink(ctx) {
        afterLinkCalls.push(ctx);
        return hooks.after?.(ctx) as never;
      },
    },
  },
});
const app = createApp(container);

let ipSeq = 0;
const freshIp = () => `${RUN}-${ipSeq++}`;

beforeEach(() => {
  hooks.before = undefined;
  hooks.after = undefined;
  afterLinkCalls.length = 0;
  beforeLinkCalls.length = 0;
  steam.calls.handleCallback.length = 0;
  twitch.calls.handleCallback.length = 0;
  steam.fails(null);
});

afterAll(async () => {
  await db
    .delete(linkedAccounts)
    .where(eq(linkedAccounts.provider, "steamreal"));
  await db
    .delete(linkedAccounts)
    .where(like(linkedAccounts.providerUserId, `${RUN}%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}%`));
  await db.delete(contacts).where(like(contacts.anonymousId, `${RUN}%`));
  await db.delete(contacts).where(like(contacts.email, `${RUN}%`));
  await client.end();
});

async function makeContact(
  fields: { externalId?: string; anonymousId?: string; email?: string } = {},
): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values({
      externalId: fields.externalId ?? null,
      anonymousId: fields.anonymousId ?? null,
      email: fields.email ?? null,
    })
    .returning({ id: contacts.id });
  if (!row) throw new Error("contact insert failed");
  return row.id;
}

function accountLinkState(
  over: Record<string, unknown> = {},
  ttlSeconds = 900,
): string {
  return signConnectorState(
    {
      purpose: "account_link",
      providerId: "steam",
      nonce: uid("nonce"),
      ...over,
    },
    SECRET,
    ttlSeconds,
  );
}

function callback(provider: string, state: string, query = "") {
  return app.request(
    `/v1/accounts/${provider}/callback?state=${encodeURIComponent(state)}${query}`,
    { headers: { "x-forwarded-for": freshIp() } },
  );
}

const liveLinks = (providerUserId: string) =>
  db
    .select()
    .from(linkedAccounts)
    .where(
      and(
        eq(linkedAccounts.providerUserId, providerUserId),
        isNull(linkedAccounts.unlinkedAt),
      ),
    );

const allLinks = (providerUserId: string) =>
  db
    .select()
    .from(linkedAccounts)
    .where(eq(linkedAccounts.providerUserId, providerUserId));

// ---------------------------------------------------------------------------
// The state check, BEFORE any exchange
// ---------------------------------------------------------------------------

describe("state verification happens before anything else", () => {
  it("rejects a forged state (bad signature) without exchanging a code", async () => {
    const token = accountLinkState({ contactId: uid("c") });
    const [payload] = token.split(".");
    const forged = `${payload}.${Buffer.from("not-the-signature").toString("base64url")}`;

    const res = await callback("steam", forged);
    expect(res.status).toBe(400);
    expect(steam.calls.handleCallback).toEqual([]);
  });

  it("never calls provider.handleCallback when the state check fails", async () => {
    // The Fake's call log is what makes "no code exchange" an assertion rather
    // than a hope. Every shape of bad state, one after another.
    const contactId = await makeContact({ externalId: uid("ext") });
    const bad = [
      "",
      "not-a-token",
      "a.b",
      accountLinkState({ contactId }, -1), // expired
      signConnectorState(
        {
          purpose: "member_link",
          connectorId: "discord",
          contactId,
          nonce: uid("nonce"),
        },
        SECRET,
        900,
      ),
      accountLinkState({ providerId: "twitch", contactId }), // cross-provider
    ];

    for (const state of bad) {
      const res = await callback("steam", state);
      expect(res.status).toBe(400);
    }
    expect(steam.calls.handleCallback).toEqual([]);
  });

  it("rejects an expired state", async () => {
    const res = await callback(
      "steam",
      accountLinkState({ contactId: uid("c") }, -1),
    );
    expect(res.status).toBe(400);
    expect(steam.calls.handleCallback).toEqual([]);
  });

  it("rejects a state whose purpose is member_link", async () => {
    const state = signConnectorState(
      {
        purpose: "member_link",
        connectorId: "steam",
        contactId: uid("c"),
        nonce: uid("nonce"),
      },
      SECRET,
      900,
    );
    const res = await callback("steam", state);
    expect(res.status).toBe(400);
    expect(steam.calls.handleCallback).toEqual([]);
  });

  it("rejects a cross-provider state (minted for steam, presented at /twitch/callback)", async () => {
    const contactId = await makeContact({ externalId: uid("ext") });
    const state = accountLinkState({ providerId: "steam", contactId });

    const res = await callback("twitch", state);
    expect(res.status).toBe(400);
    expect(twitch.calls.handleCallback).toEqual([]);
  });

  it("rejects a replayed state (second callback with the same nonce)", async () => {
    const contactId = await makeContact({ externalId: uid("ext") });
    const providerUserId = uid("steamid");
    steam.proves({ providerUserId, username: "replay-player" });
    const state = accountLinkState({ contactId });

    const first = await callback("steam", state);
    expect(first.status).toBe(200);

    const second = await callback("steam", state);
    expect(second.status).toBe(400);
    // The exchange ran ONCE. A replay that reached the provider would already
    // be a second proof attempt against a captured URL.
    expect(steam.calls.handleCallback).toHaveLength(1);
    expect(await allLinks(providerUserId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Route shape (DECISIONS §15.1)
// ---------------------------------------------------------------------------

describe("route shape", () => {
  it("GET /v1/accounts/steam/callback with no Authorization header is neither 401 nor 403", async () => {
    // The ACTUAL status, not "not 401": PRD 09's blanket param guard would
    // answer 403 from the scope check, which a "not 401" test would pass.
    const contactId = await makeContact({ externalId: uid("ext") });
    steam.proves({ providerUserId: uid("steamid") });

    const res = await callback("steam", accountLinkState({ contactId }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Steam account linked");
  });
});

// ---------------------------------------------------------------------------
// WARM binding — the sealed contact is authoritative
// ---------------------------------------------------------------------------

describe("warm binding", () => {
  it("binds to the sealed contactId and NOT to the provider-reported email", async () => {
    // The grafting test. The provider reports an email belonging to a
    // DIFFERENT existing contact; the link must land on the sealed one.
    const victimEmail = `${RUN}-victim@example.test`;
    const victimId = await makeContact({
      externalId: uid("victim"),
      email: victimEmail,
    });
    const sealedId = await makeContact({ externalId: uid("sealed") });
    const providerUserId = uid("steamid");
    steam.proves({
      providerUserId,
      username: "grafter",
      verifiedEmail: victimEmail,
    });

    const res = await callback(
      "steam",
      accountLinkState({ contactId: sealedId }),
    );
    expect(res.status).toBe(200);

    const rows = await liveLinks(providerUserId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBe(sealedId);
    expect(rows[0]?.contactId).not.toBe(victimId);
    // The verified email rides through as a display PROPERTY on the link row,
    // which is exactly what DECISIONS §6.4 permits — and nothing more.
    expect(rows[0]?.verifiedEmail).toBe(victimEmail);
  });

  it("refuses when the sealed contact no longer exists", async () => {
    // A state lives 15 minutes and a contact deletion unlinks everything that
    // contact owned (DECISIONS §15.3), so re-attaching to a dead row would
    // resurrect a link — and `linked_accounts.contact_id` is a NOT NULL FK, so
    // the alternative is an unhandled 500 on a player's callback.
    const contactId = await makeContact({ externalId: uid("gone") });
    const providerUserId = uid("steamid");
    steam.proves({ providerUserId });
    await db.delete(contacts).where(eq(contacts.id, contactId));

    const res = await callback("steam", accountLinkState({ contactId }));
    expect(res.status).toBe(400);
    expect(await allLinks(providerUserId)).toHaveLength(0);
    // Refused BEFORE the veto, so a customer hook is never asked about a
    // contact that is not there.
    expect(beforeLinkCalls).toEqual([]);
  });

  it("a warm callback CAN displace a live owner", async () => {
    const ownerId = await makeContact({ externalId: uid("owner") });
    const claimantId = await makeContact({ externalId: uid("claimant") });
    const providerUserId = uid("steamid");
    steam.proves({ providerUserId });

    const first = await callback(
      "steam",
      accountLinkState({ contactId: ownerId }),
    );
    expect(first.status).toBe(200);

    const second = await callback(
      "steam",
      accountLinkState({ contactId: claimantId }),
    );
    expect(second.status).toBe(200);

    const live = await liveLinks(providerUserId);
    expect(live).toHaveLength(1);
    expect(live[0]?.contactId).toBe(claimantId);
    // Two versions, monotonic, from the one relink transaction.
    const history = await allLinks(providerUserId);
    expect(history).toHaveLength(2);
    const versions = history.map((r) => String(r.version)).sort();
    expect(new Set(versions).size).toBe(2);
  });

  it("redirects to an allowlisted returnTo, and falls back to the page when the allowlist no longer has it", async () => {
    const contactId = await makeContact({ externalId: uid("ext") });
    steam.proves({ providerUserId: uid("steamid") });
    const ok = await callback(
      "steam",
      accountLinkState({ contactId, returnTo: `${ALLOWED}/done` }),
    );
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe(`${ALLOWED}/done`);

    // A state minted while the allowlist was wider: re-checked at REDIRECT
    // time, so it degrades to the hosted page instead of open-redirecting.
    steam.proves({ providerUserId: uid("steamid") });
    const stale = await callback(
      "steam",
      accountLinkState({ contactId, returnTo: "https://evil.test/thanks" }),
    );
    expect(stale.status).toBe(200);
    expect(stale.headers.get("location")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// COLD binding — DECISIONS §6.10
// ---------------------------------------------------------------------------

describe("cold binding", () => {
  it("a cold Steam callback with no email binds to the anonymous key", async () => {
    const anonymousId = uid("anon");
    const providerUserId = uid("steamid");
    // Steam yields NO email, ever — the anonymous key is the only thing this
    // contact can be keyed on.
    steam.proves({ providerUserId, username: "cold-player" });

    const res = await callback("steam", accountLinkState({ anonymousId }));
    expect(res.status).toBe(200);

    const rows = await liveLinks(providerUserId);
    expect(rows).toHaveLength(1);
    const [minted] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.anonymousId, anonymousId));
    expect(minted).toBeDefined();
    expect(rows[0]?.contactId).toBe(minted?.id);
    expect(minted?.email).toBeNull();
    expect(minted?.externalId).toBeNull();
  });

  it("a cold callback whose anonymous_id names an IDENTIFIED contact writes no link row and mints nothing", async () => {
    // DECISIONS §6.10. `anonymous_id` arrives on an UNAUTHENTICATED URL and is
    // browser-readable by design, so a genuinely-proven Steam account must not
    // be graftable onto a victim's identified contact by pasting their anon id.
    const anonymousId = uid("victimanon");
    const victimId = await makeContact({
      externalId: uid("victimext"),
      email: `${RUN}-identified@example.test`,
      anonymousId,
    });
    const providerUserId = uid("steamid");
    steam.proves({ providerUserId, username: "attacker" });

    const contactsBefore = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(like(contacts.anonymousId, `${RUN}%`));

    const res = await callback("steam", accountLinkState({ anonymousId }));
    expect(res.status).toBe(400);

    // No link row AT ALL — not on the victim, not anywhere.
    expect(await allLinks(providerUserId)).toHaveLength(0);
    const contactsAfter = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(like(contacts.anonymousId, `${RUN}%`));
    expect(contactsAfter).toHaveLength(contactsBefore.length);
    // And the victim is untouched.
    const [victim] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, victimId));
    expect(victim?.anonymousId).toBe(anonymousId);
  });

  it("a cold callback whose anonymous_id is an identified victim's EXTERNAL id mints no doppelganger", async () => {
    // The takeover the anonymous-only clamp does NOT stop, and which the test
    // above structurally cannot reach because it seeds the victim WITH the
    // attacked value as their `anonymous_id` (the one shape that hits the
    // fill-in-link arm the clamp guards).
    //
    // Here the victim is keyed by `external_id` with `anonymous_id` NULL, so a
    // cold resolve finds NO candidate, never consults the clamp, and mints a
    // fresh contact carrying `anonymous_id = <victim's external_id>`. Canonical
    // key is `external_id ?? anonymous_id ?? id`, so that row's userId IS the
    // victim's player id, and `afterLink` would hand the publisher
    // `{ userId: <victim>, providerUserId: <attacker's steam> }` — entitling
    // the attacker's account as the victim.
    const victimKey = uid("victimext");
    const victimId = await makeContact({
      externalId: victimKey,
      email: `${RUN}-doppel@example.test`,
    });
    const providerUserId = uid("steamid");
    steam.proves({ providerUserId, username: "attacker" });

    const before = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(like(contacts.anonymousId, `${RUN}%`));

    // The attacker supplies the victim's EXTERNAL id as an anonymous_id.
    const res = await callback(
      "steam",
      accountLinkState({ anonymousId: victimKey }),
    );
    expect(res.status).toBe(400);

    // No link row, and crucially no new contact carrying the victim's key.
    expect(await allLinks(providerUserId)).toHaveLength(0);
    const after = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(like(contacts.anonymousId, `${RUN}%`));
    expect(after).toHaveLength(before.length);
    const doppelganger = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.anonymousId, victimKey));
    expect(doppelganger).toHaveLength(0);

    // The victim is untouched.
    const [victim] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, victimId));
    expect(victim?.externalId).toBe(victimKey);
    expect(victim?.anonymousId).toBeNull();
  });

  it("a cold callback cannot displace a live owner", async () => {
    const ownerId = await makeContact({ externalId: uid("owner") });
    const providerUserId = uid("steamid");
    steam.proves({ providerUserId });

    const warm = await callback(
      "steam",
      accountLinkState({ contactId: ownerId }),
    );
    expect(warm.status).toBe(200);

    const anonymousId = uid("anon");
    const cold = await callback("steam", accountLinkState({ anonymousId }));
    expect(cold.status).toBe(400);

    // The existing live link survives, on its original owner.
    const live = await liveLinks(providerUserId);
    expect(live).toHaveLength(1);
    expect(live[0]?.contactId).toBe(ownerId);
    expect(await allLinks(providerUserId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Hooks — the store is the sole after-hook invoker (DECISIONS §15.4)
// ---------------------------------------------------------------------------

describe("hooks", () => {
  it("a successful callback invokes afterLink exactly once", async () => {
    const contactId = await makeContact({ externalId: uid("ext") });
    const providerUserId = uid("steamid");
    steam.proves({ providerUserId });

    const res = await callback("steam", accountLinkState({ contactId }));
    expect(res.status).toBe(200);
    // Exactly once. Two invocations would mean this route invoked the hook as
    // well as the store, and because the hooks are documented at-least-once
    // nothing would have failed loudly.
    expect(afterLinkCalls).toHaveLength(1);
    expect(afterLinkCalls[0]?.contactId).toBe(contactId);
    expect(afterLinkCalls[0]?.method).toBe("oauth");
    expect(afterLinkCalls[0]?.relink).toBe(false);
    expect(typeof afterLinkCalls[0]?.version).toBe("string");
  });

  it("beforeLink runs before the write and sees the sealed contact", async () => {
    const contactId = await makeContact({
      externalId: uid("ext"),
      email: `${RUN}-owner@example.test`,
    });
    const providerUserId = uid("steamid");
    steam.proves({ providerUserId });
    const seenLinkRows: number[] = [];
    hooks.before = async () => {
      seenLinkRows.push((await allLinks(providerUserId)).length);
    };

    const res = await callback("steam", accountLinkState({ contactId }));
    expect(res.status).toBe(200);
    expect(beforeLinkCalls).toHaveLength(1);
    expect(beforeLinkCalls[0]?.contactId).toBe(contactId);
    expect(beforeLinkCalls[0]?.email).toBe(`${RUN}-owner@example.test`);
    expect(beforeLinkCalls[0]?.userId).toBeTruthy();
    // Nothing was written when the veto ran.
    expect(seenLinkRows).toEqual([0]);
  });

  it("beforeLink on a cold callback sees contactId null and anonymousId set", async () => {
    const anonymousId = uid("anon");
    steam.proves({ providerUserId: uid("steamid") });

    const res = await callback("steam", accountLinkState({ anonymousId }));
    expect(res.status).toBe(200);
    expect(beforeLinkCalls).toHaveLength(1);
    expect(beforeLinkCalls[0]?.contactId).toBeNull();
    expect(beforeLinkCalls[0]?.anonymousId).toBe(anonymousId);
    expect(beforeLinkCalls[0]?.userId).toBeNull();
    expect(beforeLinkCalls[0]?.email).toBeNull();
  });

  it("a throwing afterLink still renders the success page", async () => {
    const contactId = await makeContact({ externalId: uid("ext") });
    const providerUserId = uid("steamid");
    steam.proves({ providerUserId });
    hooks.after = () => {
      throw new Error("consumer webhook exploded");
    };

    const res = await callback("steam", accountLinkState({ contactId }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Steam account linked");
    // Fail-OPEN: the row is committed and the hook's failure changes nothing.
    expect(await liveLinks(providerUserId)).toHaveLength(1);
  });

  it("an afterLink that hangs is abandoned at 5s and the page still renders", async () => {
    const contactId = await makeContact({ externalId: uid("ext") });
    const providerUserId = uid("steamid");
    steam.proves({ providerUserId });
    hooks.after = () =>
      new Promise(() => {
        /* never settles */
      });

    const started = Date.now();
    const res = await callback("steam", accountLinkState({ contactId }));
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    expect(await liveLinks(providerUserId)).toHaveLength(1);
    // Bounded at the ONE timeout constant, not merely "eventually".
    expect(elapsed).toBeGreaterThanOrEqual(4_800);
    expect(elapsed).toBeLessThan(15_000);
  });
});

// ---------------------------------------------------------------------------
// Provider failures
// ---------------------------------------------------------------------------

describe("the REAL Steam preset, driven through both routes offline", () => {
  it("start → callback completes and the openid.return_to echo binds", async () => {
    // Steam is OpenID 2.0: no `state` parameter exists, so the signed state
    // rides in `openid.return_to` and the preset compares the echo BYTE-FOR-
    // BYTE against the redirectUri the callback presents. If this route
    // presented the bare callback URL there (as an OAuth2 provider needs), the
    // real Steam flow would refuse every assertion with `state_invalid`.
    const contactId = await makeContact({ externalId: uid("ext") });
    const steamId = "76561197960435530";
    const warm = signConnectorState(
      {
        purpose: "account_link",
        providerId: "steamreal",
        contactId,
        nonce: uid("nonce"),
      },
      SECRET,
      900,
    );

    const started = await app.request(
      `/v1/accounts/steamreal/start?t=${encodeURIComponent(warm)}`,
      { headers: { "x-forwarded-for": freshIp() } },
    );
    expect(started.status).toBe(302);
    const authorize = new URL(started.headers.get("location") as string);
    expect(authorize.origin + authorize.pathname).toBe(STEAM_OPENID_ENDPOINT);
    const returnTo = authorize.searchParams.get("openid.return_to") as string;
    expect(returnTo).toContain("/v1/accounts/steamreal/callback");
    const state = new URL(returnTo).searchParams.get("state") as string;

    // The `check_authentication` round trip, answered locally. The endpoint is
    // hardcoded in the preset, so this also pins that we never let the
    // callback name its own verifier.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        expect(String(input)).toBe(STEAM_OPENID_ENDPOINT);
        return new Response(
          "ns:http://specs.openid.net/auth/2.0\nis_valid:true\n",
          {
            status: 200,
            headers: { "content-type": "text/plain" },
          },
        );
      });

    try {
      const params = new URLSearchParams({
        "openid.ns": "http://specs.openid.net/auth/2.0",
        "openid.mode": "id_res",
        "openid.op_endpoint": STEAM_OPENID_ENDPOINT,
        "openid.claimed_id": `https://steamcommunity.com/openid/id/${steamId}`,
        "openid.identity": `https://steamcommunity.com/openid/id/${steamId}`,
        "openid.return_to": returnTo,
        "openid.response_nonce": "2026-08-14T00:00:00Znonce",
        "openid.assoc_handle": "1234567890",
        "openid.signed": "signed,op_endpoint,claimed_id,identity,return_to",
        "openid.sig": "fixture-signature",
        state,
      });
      const res = await app.request(
        `/v1/accounts/steamreal/callback?${params.toString()}`,
        { headers: { "x-forwarded-for": freshIp() } },
      );
      expect(res.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }

    const rows = await db
      .select()
      .from(linkedAccounts)
      .where(
        and(
          eq(linkedAccounts.provider, "steamreal"),
          eq(linkedAccounts.providerUserId, steamId),
          eq(linkedAccounts.contactId, contactId),
        ),
      );
    expect(rows).toHaveLength(1);
    // Steam yields no email and no tokens, EVER.
    expect(rows[0]?.verifiedEmail).toBeNull();
    expect(rows[0]?.tokens).toBeNull();
  });
});

describe("provider failures", () => {
  it("renders the error page and writes nothing when handleCallback throws", async () => {
    const { AccountLinkCallbackError } = await import("@hogsend/core");
    const contactId = await makeContact({ externalId: uid("ext") });
    const providerUserId = uid("steamid");
    steam.proves({ providerUserId });

    for (const error of [
      new AccountLinkCallbackError("denied", "player cancelled"),
      new AccountLinkCallbackError("exchange_failed", "steam 503"),
      new Error("something else entirely"),
    ]) {
      steam.fails(error);
      const res = await callback("steam", accountLinkState({ contactId }));
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("We couldn't link your Steam account");
      // The error page never says WHICH reason — that is an operator fact on
      // `account.link_failed`, not a probing oracle for a player.
      expect(body).not.toContain("denied");
      expect(body).not.toContain("exchange_failed");
    }
    steam.fails(null);
    expect(await allLinks(providerUserId)).toHaveLength(0);
    // A failure never mints a contact, and never runs the veto.
    expect(beforeLinkCalls).toEqual([]);
    expect(afterLinkCalls).toEqual([]);
  });
});
