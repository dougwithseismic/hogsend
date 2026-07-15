import { describe, expect, it, vi } from "vitest";
import { createHogsend } from "../client.js";

// ---------------------------------------------------------------------------
// Fetch mock harness — records every telemetry POST body so we can assert the
// `groups` association travels on the `/v1/events` payload.
// ---------------------------------------------------------------------------

interface RecordedCall {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

function makeFetch() {
  const calls: RecordedCall[] = [];
  const fetchImpl = vi.fn(
    async (input: string | URL, init?: RequestInit): Promise<Response> => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body:
          typeof init?.body === "string"
            ? JSON.parse(init.body)
            : ({} as Record<string, unknown>),
      });
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

/** The body of the single `/v1/events` POST since the last flush. */
function lastEventBody(calls: RecordedCall[]): Record<string, unknown> {
  const events = calls.filter((c) => c.url.endsWith("/v1/events"));
  const last = events[events.length - 1];
  if (!last) throw new Error("no /v1/events POST recorded");
  return last.body;
}

describe("groups (association-only)", () => {
  it("starts with an empty groups slice", () => {
    const { fetchImpl } = makeFetch();
    const hs = newClient(fetchImpl as unknown as typeof fetch);
    expect(hs.getGroups()).toEqual({});
    expect(hs.getSnapshot().groups).toEqual({});
  });

  it("group() merges into the slice and a capture carries the groups map", async () => {
    const { fetchImpl, calls } = makeFetch();
    const hs = newClient(fetchImpl as unknown as typeof fetch);

    hs.group("company", "acme");
    expect(hs.getGroups()).toEqual({ company: "acme" });

    await hs.capture("x");
    await hs.flush();

    const body = lastEventBody(calls);
    expect(body.name).toBe("x");
    expect(body.source).toBe("inapp");
    expect(body.groups).toEqual({ company: "acme" });
  });

  it("merges multiple group types across calls", async () => {
    const { fetchImpl, calls } = makeFetch();
    const hs = newClient(fetchImpl as unknown as typeof fetch);

    hs.group("company", "acme");
    hs.group("team", "growth");
    await hs.capture("x");
    await hs.flush();

    expect(lastEventBody(calls).groups).toEqual({
      company: "acme",
      team: "growth",
    });
  });

  it("resetGroups() clears the slice so a later capture carries no groups", async () => {
    const { fetchImpl, calls } = makeFetch();
    const hs = newClient(fetchImpl as unknown as typeof fetch);

    hs.group("company", "acme");
    hs.resetGroups();
    expect(hs.getGroups()).toEqual({});

    await hs.capture("y");
    await hs.flush();

    expect(lastEventBody(calls).groups).toBeUndefined();
  });

  it("reset() also drops group associations (PostHog parity)", async () => {
    const { fetchImpl, calls } = makeFetch();
    const hs = newClient(fetchImpl as unknown as typeof fetch);

    hs.group("company", "acme");
    hs.reset();
    expect(hs.getGroups()).toEqual({});

    await hs.capture("z");
    await hs.flush();

    expect(lastEventBody(calls).groups).toBeUndefined();
  });
});
