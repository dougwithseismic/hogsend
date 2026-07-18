import { describe, expect, it, vi } from "vitest";
import { createHogsend } from "../client.js";

// ---------------------------------------------------------------------------
// A late-arriving userToken must apply in place (no remount): setUserToken()
// re-authenticates connected feeds, and reset() drops the token so a
// logged-out client stops sending stale auth.
// ---------------------------------------------------------------------------

function makeFetch() {
  const urls: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL): Promise<Response> => {
    urls.push(String(input));
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      async text() {
        return JSON.stringify({ items: [], pageInfo: {}, stored: true });
      },
    } as unknown as Response;
  });
  return { fetchImpl, urls };
}

function newClient(fetchImpl: typeof fetch) {
  return createHogsend({
    apiUrl: "https://api.test.local",
    publishableKey: "pk_test",
    fetch: fetchImpl,
    flushOnUnload: false,
    captureRef: false,
    captureAttribution: false,
  });
}

const feedGets = (urls: string[]) =>
  urls.filter((u) => u.includes("/v1/feed") && !u.includes("/mark"));

describe("late userToken applies without a remount", () => {
  it("setUserToken re-fetches connected feeds carrying the new token", async () => {
    const { fetchImpl, urls } = makeFetch();
    const hs = newClient(fetchImpl as unknown as typeof fetch);
    await hs.identify("user_1");

    const feed = hs.feed("in_app");
    await feed.fetch();
    const before = feedGets(urls).length;
    expect(before).toBeGreaterThan(0);
    // The anon-era fetch carried no token (token gates on userId AND token).
    expect(feedGets(urls).some((u) => u.includes("userToken"))).toBe(false);

    hs.setUserToken("tok_abc");
    // setUserToken triggers a refetch of the already-connected feed.
    await vi.waitFor(() =>
      expect(feedGets(urls).length).toBeGreaterThan(before),
    );
    expect(feedGets(urls).at(-1)).toContain("userToken=tok_abc");
  });

  it("reset() clears the previous recipient's feed items (no cross-user leak)", async () => {
    const { fetchImpl, urls } = makeFetch();
    // First fetch returns User A's item; after reset the anon fetch is empty.
    let phase: "user" | "anon" = "user";
    (
      fetchImpl as unknown as { mockImplementation: (f: unknown) => void }
    ).mockImplementation(async (input: string | URL): Promise<Response> => {
      urls.push(String(input));
      const items =
        phase === "user" && String(input).includes("/v1/feed")
          ? [{ id: "a1", createdAt: "2026-07-18T00:00:00Z", status: "unseen" }]
          : [];
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        async text() {
          return JSON.stringify({ items, pageInfo: {}, metadata: {} });
        },
      } as unknown as Response;
    });
    const hs = newClient(fetchImpl as unknown as typeof fetch);
    await hs.identify("user_A");
    hs.setUserToken("tok_A");
    const feed = hs.feed("in_app");
    await feed.fetch();
    expect(Object.keys(hs.getSnapshot().feeds?.in_app?.byId ?? {})).toEqual([
      "a1",
    ]);

    phase = "anon";
    hs.reset();
    // The slice is cleared synchronously (emits immediately) — no lingering A.
    expect(hs.getSnapshot().feeds?.in_app?.byId ?? {}).toEqual({});
  });

  it("reset() clears the token so later reads drop the stale auth", async () => {
    const { fetchImpl, urls } = makeFetch();
    const hs = newClient(fetchImpl as unknown as typeof fetch);
    await hs.identify("user_1");
    hs.setUserToken("tok_abc");
    const feed = hs.feed("in_app");
    await feed.fetch();
    expect(feedGets(urls).at(-1)).toContain("userToken=tok_abc");

    hs.reset();
    await hs.identify("user_1");
    await feed.fetch();
    expect(feedGets(urls).at(-1)).not.toContain("userToken");
  });
});
