import { afterEach, describe, expect, it, vi } from "vitest";
import { bootSnippet, readScriptOptions } from "../snippet.js";

// ---------------------------------------------------------------------------
// The drop-in `<script>` entry: reads its config off the tag, replaces the
// async stub on `window.hogsend`, replays queued calls, and never throws.
// ---------------------------------------------------------------------------

function fakeScript(dataset: Record<string, string>, src?: string) {
  return { dataset, src: src ?? "" } as unknown as HTMLScriptElement;
}

function makeFetch() {
  const bodies: string[] = [];
  const fetchImpl = vi.fn(
    async (_input: string | URL, init?: RequestInit): Promise<Response> => {
      bodies.push(String(init?.body ?? ""));
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        async text() {
          return JSON.stringify({ stored: true });
        },
      } as unknown as Response;
    },
  );
  return { fetchImpl: fetchImpl as unknown as typeof fetch, bodies };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readScriptOptions", () => {
  it("reads data-* and defaults host to the script's origin", () => {
    const opts = readScriptOptions(
      fakeScript(
        { key: "pk_x", userId: "u1", pageview: "true" },
        "https://api.acme.com/hogsend.js?v=1",
      ),
    );
    expect(opts).toEqual({
      key: "pk_x",
      host: "https://api.acme.com",
      userId: "u1",
      pageview: true,
    });
  });

  it("prefers an explicit data-host and defaults pageview off", () => {
    const opts = readScriptOptions(
      fakeScript(
        { key: "pk_x", host: "https://hs.acme.com/" },
        "https://cdn.x/h.js",
      ),
    );
    expect(opts.host).toBe("https://hs.acme.com/");
    expect(opts.pageview).toBe(false);
  });

  it("returns {} for a missing script element", () => {
    expect(readScriptOptions(null)).toEqual({});
  });
});

describe("bootSnippet", () => {
  it("warns and returns null without a key instead of throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(bootSnippet({ host: "https://api.test.local" })).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("installs window.hogsend, replays the stub queue, fires hogsend:ready", async () => {
    const { fetchImpl, bodies } = makeFetch();
    const events: CustomEvent[] = [];
    const win: Record<string, unknown> = {
      hogsend: { _q: [["capture", "queued_event", { a: 1 }]] },
    };
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", {
      dispatchEvent: (e: CustomEvent) => {
        events.push(e);
        return true;
      },
    });

    const client = bootSnippet({
      key: "pk_test",
      host: "https://api.test.local",
      fetch: fetchImpl,
      pageview: true,
    });

    expect(client).not.toBeNull();
    expect(win.hogsend).toBe(client);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("hogsend:ready");
    expect(events[0]?.detail).toBe(client);

    await client?.flush();
    const sent = bodies.join("\n");
    expect(sent).toContain("queued_event");
    expect(sent).toContain("$pageview");
    client?.teardown();
  });
});
