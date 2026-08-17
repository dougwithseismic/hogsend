// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHogsend } from "../client.js";
import { mountBanner, mountToasts } from "../ui/index.js";

// ---------------------------------------------------------------------------
// Vanilla renderers: banner slot + toast stack driven by the client's own
// sub-clients. Same event story as the React components.
// ---------------------------------------------------------------------------

const bannerItem = {
  id: "b1",
  type: "banner",
  category: "banner:top",
  title: "Hello",
  body: "World",
  actionUrl: "https://acme.test/x",
  metadata: null,
  read: false,
  archived: false,
  createdAt: new Date().toISOString(),
};

function makeClient(items: unknown[] = []) {
  const bodies: string[] = [];
  const fetchImpl = vi.fn(
    async (input: string | URL, init?: RequestInit): Promise<Response> => {
      bodies.push(String(init?.body ?? ""));
      const url = String(input);
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        async text() {
          return url.includes("/v1/feed")
            ? JSON.stringify({ items, pageInfo: {}, stored: true })
            : JSON.stringify({ stored: true });
        },
      } as unknown as Response;
    },
  );
  const client = createHogsend({
    apiUrl: "https://api.test.local",
    publishableKey: "pk_test",
    fetch: fetchImpl as unknown as typeof fetch,
    flushOnUnload: false,
    captureRef: false,
    captureAttribution: false,
    realtime: "off",
  });
  return { client, bodies };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("mountBanner", () => {
  it("renders the current banner, emits banner.shown once, wires dismiss", async () => {
    document.body.innerHTML = '<div id="slot"></div>';
    const { client, bodies } = makeClient([bannerItem]);
    const mounted = mountBanner(client, "#slot", { slot: "top" });
    await tick();
    const root = document.querySelector(".hs-banner");
    expect(root).not.toBeNull();
    expect(root?.querySelector(".hs-banner__title")?.textContent).toBe("Hello");
    expect(root?.querySelector("a")?.getAttribute("href")).toBe(
      "https://acme.test/x",
    );
    await client.flush();
    expect(bodies.join("\n")).toContain("banner.shown");
    expect(document.getElementById("hs-ui-styles")).not.toBeNull();

    (root?.querySelector(".hs-banner__dismiss") as HTMLButtonElement).click();
    await tick();
    await client.flush();
    expect(bodies.join("\n")).toContain("banner.dismissed");

    mounted.destroy();
    expect(document.querySelector(".hs-banner")).toBeNull();
    client.teardown();
  });

  it("warns and no-ops on a missing target", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = makeClient();
    mountBanner(client, "#nope").destroy();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
    client.teardown();
  });
});

describe("mountToasts", () => {
  it("renders toasts from the toast client and removes on dismiss", () => {
    const { client } = makeClient();
    const mounted = mountToasts(client, undefined, { position: "top-left" });
    const host = document.querySelector(".hs-toasts") as HTMLElement;
    expect(host.dataset.position).toBe("top-left");
    const id = client.toasts().show({
      type: "toast",
      title: "Saved",
      body: null,
      actionUrl: null,
      metadata: null,
    });
    expect(host.querySelectorAll(".hs-toast")).toHaveLength(1);
    client.toasts().dismiss(id);
    expect(host.querySelectorAll(".hs-toast")).toHaveLength(0);
    mounted.destroy();
    expect(document.querySelector(".hs-toasts")).toBeNull();
    client.teardown();
  });
});
