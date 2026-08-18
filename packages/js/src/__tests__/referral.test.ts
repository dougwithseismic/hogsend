import { describe, expect, it, vi } from "vitest";
import { createHogsend } from "../client.js";

// ---------------------------------------------------------------------------
// Fetch mock harness: records every request and serves one canned body for
// `GET /v1/referrals/me` (everything else is the telemetry 202).
// ---------------------------------------------------------------------------

interface RecordedCall {
  url: string;
  method: string;
}

interface MeSpec {
  status?: number;
  body?: unknown;
  throws?: boolean;
}

function makeFetch(me: MeSpec = {}) {
  const calls: RecordedCall[] = [];
  const fetchImpl = vi.fn(
    async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.includes("/v1/referrals/me")) {
        if (me.throws) throw new Error("offline");
        const status = me.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          headers: new Headers(),
          async text() {
            return JSON.stringify(me.body ?? { link: null, stats: null });
          },
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 202,
        headers: new Headers(),
        async text() {
          return JSON.stringify({ stored: true });
        },
      } as unknown as Response;
    },
  );
  return { fetchImpl, calls };
}

function newClient(fetchImpl: typeof fetch, userToken?: string) {
  return createHogsend({
    apiUrl: "https://api.test.local",
    publishableKey: "pk_test",
    fetch: fetchImpl,
    flushOnUnload: false,
    captureRef: false,
    captureAttribution: false,
    ...(userToken ? { userToken } : {}),
  });
}

const ME = {
  link: { url: "https://app.test/r/abc", slug: "abc" },
  stats: { touched: 3, bound: 2, qualified: 1 },
};

/** Calls to `/v1/referrals/me` only. */
function meCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.url.includes("/v1/referrals/me"));
}

describe("referral.link (userToken-gated)", () => {
  it("does not fetch on init", () => {
    const { fetchImpl, calls } = makeFetch({ body: ME });
    newClient(fetchImpl as unknown as typeof fetch, "ut_1");
    expect(meCalls(calls)).toHaveLength(0);
  });

  it("returns null and issues NO request without a userToken", async () => {
    const { fetchImpl, calls } = makeFetch({ body: ME });
    const hs = newClient(fetchImpl as unknown as typeof fetch);
    await expect(hs.referral.link()).resolves.toBeNull();
    expect(meCalls(calls)).toHaveLength(0);
    expect(hs.referral.getLink()).toBeNull();
  });

  it("fetches with the token and writes the reactive slice", async () => {
    const { fetchImpl, calls } = makeFetch({ body: ME });
    const hs = newClient(fetchImpl as unknown as typeof fetch, "ut_1");
    const res = await hs.referral.link({ referral: "invite" });
    expect(res).toEqual(ME);

    const url = new URL(meCalls(calls)[0]?.url ?? "");
    expect(url.pathname).toBe("/v1/referrals/me");
    expect(url.searchParams.get("userToken")).toBe("ut_1");
    expect(url.searchParams.get("referral")).toBe("invite");

    expect(hs.getSnapshot().referral).toEqual({ ...ME, loading: false });
    expect(hs.referral.getLink()).toEqual(ME);
  });

  it("notifies store subscribers when the slice lands", async () => {
    const { fetchImpl } = makeFetch({ body: ME });
    const hs = newClient(fetchImpl as unknown as typeof fetch, "ut_1");
    const seen: unknown[] = [];
    const unsub = hs.subscribe(() => {
      seen.push(hs.getSnapshot().referral);
    });
    await hs.referral.link();
    unsub();
    expect(seen.length).toBeGreaterThan(0);
    expect(hs.getSnapshot().referral?.loading).toBe(false);
  });

  it("returns null on the non-confirming two-null answer", async () => {
    const { fetchImpl } = makeFetch({ body: { link: null, stats: null } });
    const hs = newClient(fetchImpl as unknown as typeof fetch, "ut_forged");
    await expect(hs.referral.link()).resolves.toBeNull();
    expect(hs.getSnapshot().referral).toEqual({
      link: null,
      stats: null,
      loading: false,
    });
  });

  it("never rejects on a 401 and clears loading", async () => {
    const { fetchImpl } = makeFetch({ status: 401, body: { error: "nope" } });
    const hs = newClient(fetchImpl as unknown as typeof fetch, "ut_1");
    await expect(hs.referral.link()).resolves.toBeNull();
    expect(hs.getSnapshot().referral?.loading).toBe(false);
  });

  it("never rejects on a transport failure and keeps the last-good link", async () => {
    const { fetchImpl, calls } = makeFetch({ body: ME });
    const hs = newClient(fetchImpl as unknown as typeof fetch, "ut_1");
    await hs.referral.link();
    // Second call fails: the previously fetched link survives.
    fetchImpl.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    await expect(hs.referral.link()).resolves.toEqual(ME);
    expect(hs.referral.getLink()).toEqual(ME);
    expect(meCalls(calls)).toHaveLength(1);
  });

  it("clears the slice when the identity flips", async () => {
    const { fetchImpl } = makeFetch({ body: ME });
    const hs = newClient(fetchImpl as unknown as typeof fetch, "ut_1");
    await hs.referral.link();
    expect(hs.referral.getLink()).toEqual(ME);
    hs.reset();
    expect(hs.referral.getLink()).toBeNull();
  });

  it("exposes no capture API (touches ride the arrival beacon)", () => {
    const { fetchImpl } = makeFetch();
    const hs = newClient(fetchImpl as unknown as typeof fetch);
    expect(
      (hs.referral as unknown as Record<string, unknown>).capture,
    ).toBeUndefined();
    expect(typeof hs.captureRef).toBe("function");
  });
});
