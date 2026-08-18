import { describe, expect, it, vi } from "vitest";
import { createHogsend } from "../client.js";

// ---------------------------------------------------------------------------
// Fetch harness — records every request and serves a scripted
// `GET /v1/contacts/me` projection so we can assert the slice wiring.
// ---------------------------------------------------------------------------

interface RecordedCall {
  url: string;
  method: string;
}

interface ContactBody {
  identified: boolean;
  traits: Record<string, unknown>;
  email?: string | null;
}

function makeFetch(bodies: ContactBody[]) {
  const calls: RecordedCall[] = [];
  let next = 0;
  const fetchImpl = vi.fn(
    async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      const isContactMe = url.includes("/v1/contacts/me");
      const body = isContactMe
        ? (bodies[Math.min(next++, bodies.length - 1)] ?? {
            identified: false,
            traits: {},
          })
        : { ok: true };
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        async text() {
          return JSON.stringify(body);
        },
      } as unknown as Response;
    },
  );
  return { fetchImpl, calls };
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

const contactCalls = (calls: RecordedCall[]) =>
  calls.filter((c) => c.url.includes("/v1/contacts/me"));

/** Let the fire-and-forget refresh promises settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("contact traits", () => {
  it("refresh on init writes the slice", async () => {
    const { fetchImpl, calls } = makeFetch([
      { identified: true, traits: { plan: "pro" } },
    ]);
    const hs = newClient(fetchImpl as unknown as typeof fetch);
    await settle();

    expect(contactCalls(calls).length).toBeGreaterThanOrEqual(1);
    expect(hs.getContact()).toEqual({
      identified: true,
      traits: { plan: "pro" },
    });
    expect(hs.getTrait("plan")).toBe("pro");
    expect(hs.getTrait("nope")).toBeUndefined();
    expect(hs.getSnapshot().contact?.traits).toEqual({ plan: "pro" });
  });

  it("email rides along only when the engine returns it", async () => {
    const { fetchImpl } = makeFetch([
      { identified: true, traits: {}, email: "a@b.test" },
    ]);
    const hs = newClient(fetchImpl as unknown as typeof fetch);
    await settle();
    expect(hs.getContact().email).toBe("a@b.test");
  });

  it("reset clears the slice", async () => {
    const { fetchImpl } = makeFetch([
      { identified: true, traits: { plan: "pro" } },
      { identified: false, traits: {} },
    ]);
    const hs = newClient(fetchImpl as unknown as typeof fetch);
    await settle();
    expect(hs.getContact().traits).toEqual({ plan: "pro" });

    hs.reset();
    // Cleared SYNCHRONOUSLY — the previous contact's traits must not be
    // readable while the anonymous refetch is in flight.
    expect(hs.getContact()).toEqual({ identified: false, traits: {} });
  });

  it("identify refetches after the PUT and lands the new projection", async () => {
    const { fetchImpl, calls } = makeFetch([
      { identified: false, traits: {} },
      { identified: true, traits: { plan: "pro" } },
      { identified: true, traits: { plan: "pro" } },
    ]);
    const hs = newClient(fetchImpl as unknown as typeof fetch);
    await settle();
    const before = contactCalls(calls).length;

    await hs.identify("user_1", { plan: "pro" });

    const after = contactCalls(calls).length;
    expect(after).toBeGreaterThan(before);
    // The last contacts/me read is ordered AFTER the identify PUT.
    const puts = calls
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.method === "PUT" && c.url.endsWith("/v1/contacts"));
    const lastPut = puts[puts.length - 1];
    const lastRead = calls
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.url.includes("/v1/contacts/me"))
      .pop();
    expect(lastPut).toBeDefined();
    expect(lastRead?.i).toBeGreaterThan(lastPut?.i ?? -1);
    expect(hs.getContact().traits).toEqual({ plan: "pro" });
  });

  it("a stale pre-PUT read cannot overwrite the post-PUT projection", async () => {
    // identify() fires TWO reads: one from the distinctId-change subscriber
    // (before the PUT) and one after it resolves. Hold the first open and
    // release it LAST, so only the sequence guard keeps the fresh projection.
    const bodies: ContactBody[] = [
      { identified: false, traits: {} },
      { identified: false, traits: {} },
      { identified: true, traits: { plan: "pro" } },
    ];
    let n = 0;
    let releaseStale: (() => void) | undefined;
    const fetchImpl = vi.fn(async (input: string | URL): Promise<Response> => {
      const url = String(input);
      const isContactMe = url.includes("/v1/contacts/me");
      const body = isContactMe
        ? (bodies[Math.min(n, bodies.length - 1)] ?? {
            identified: false,
            traits: {},
          })
        : { ok: true };
      const index = isContactMe ? n++ : -1;
      if (index === 1) {
        await new Promise<void>((r) => {
          releaseStale = r;
        });
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        async text() {
          return JSON.stringify(body);
        },
      } as unknown as Response;
    });

    const hs = newClient(fetchImpl as unknown as typeof fetch);
    await settle();

    await hs.identify("user_1", { plan: "pro" });
    expect(hs.getContact().traits).toEqual({ plan: "pro" });

    releaseStale?.();
    await settle();
    // The late pre-PUT response is discarded, not written.
    expect(hs.getContact()).toEqual({
      identified: true,
      traits: { plan: "pro" },
    });
  });

  it("a failed fetch leaves the slice empty rather than rejecting", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      throw new Error("offline");
    });
    const hs = newClient(fetchImpl as unknown as typeof fetch);
    await settle();
    expect(hs.getContact()).toEqual({ identified: false, traits: {} });
  });
});
