import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

// DB + Redis touching: the cold-connect exchange seals a token in Redis, then
// `ingestEvent`s a contact merge into the real docker TimescaleDB. Point at the
// dev DB (matches CI's 5434); Redis comes from REDIS_URL (CI 6379 / local shell).
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts } = await import("@hogsend/db");
const { eq, like } = await import("drizzle-orm");
const { createApp, createColdConnect, createHogsendClient } = await import(
  "@hogsend/engine"
);

// Hatchet via the override seam — the exchange's `ingestEvent` push lands on a
// spy instead of a live engine, keeping the route off the network.
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

const RUN = `cc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const emailFor = (s: string) => `${s}.${RUN}@example.com`;

const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const { db } = container;

// A no-side-effect connector and a second one (cross-connector isolation), plus
// one whose afterBind always throws (at-least-once / consume-on-throw).
let afterBindRan = 0;
const COPY = {
  blurb: "b",
  successCopy: { heading: "ok", body: "ok" },
  errorCopy: { heading: "no", body: "no" },
};
const cca = createColdConnect({
  connectorId: `cca-${RUN}`,
  identityKind: "userId",
  platformKey: (id) => `cca:${id}`,
  linkedEvent: "cca.linked",
  identifyPropKey: "cca_id",
  buildIngest: () => ({ eventProperties: { source: "cca" } }),
  branding: { ...COPY, badge: "🅰️", title: "Connect A" },
  throttle: { perUser: { max: 100 }, perEmail: { max: 100 } },
});
const ccb = createColdConnect({
  connectorId: `ccb-${RUN}`,
  identityKind: "userId",
  platformKey: (id) => `ccb:${id}`,
  linkedEvent: "ccb.linked",
  identifyPropKey: "ccb_id",
  buildIngest: () => ({ eventProperties: { source: "ccb" } }),
  branding: { ...COPY, badge: "🅱️", title: "Connect B" },
  throttle: { perUser: { max: 100 }, perEmail: { max: 100 } },
});
const ccThrow = createColdConnect({
  connectorId: `ccx-${RUN}`,
  identityKind: "userId",
  platformKey: (id) => `ccx:${id}`,
  linkedEvent: "ccx.linked",
  identifyPropKey: "ccx_id",
  buildIngest: () => ({ eventProperties: { source: "ccx" } }),
  branding: { ...COPY, badge: "❌", title: "Connect X" },
  throttle: { perUser: { max: 100 }, perEmail: { max: 100 } },
  afterBind: async () => {
    afterBindRan += 1;
    throw new Error("afterBind boom");
  },
});

// Hostile branding: a title carrying a </script> breakout + a malformed iconSvg
// that must NOT be raw-inlined. Exercises the page-render security hardening.
const ccHostile = createColdConnect({
  connectorId: `cch-${RUN}`,
  identityKind: "userId",
  platformKey: (id) => `cch:${id}`,
  linkedEvent: "cch.linked",
  identifyPropKey: "cch_id",
  buildIngest: () => ({ eventProperties: { source: "cch" } }),
  branding: {
    ...COPY,
    badge: "✈️",
    iconSvg: "<img src=x onerror=alert(1)>",
    title: "Pwn</script><script>alert(1)</script>",
  },
  throttle: { perUser: { max: 100 }, perEmail: { max: 100 } },
});

const app = createApp(container, {
  routes: [cca.routes, ccb.routes, ccThrow.routes, ccHostile.routes],
});

const post = (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

afterAll(async () => {
  // Sweep every contact this run minted (emails are RUN-namespaced).
  await db.delete(contacts).where(like(contacts.email, `%${RUN}@example.com`));
});

describe("cold-connect exchange", () => {
  it("binds on POST, folds platform-key + email onto one contact, returns the server key, consumes the token", async () => {
    const email = emailFor("ok");
    const minted = await cca.mintConfirm({ platformUserId: "u1", email });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    const res = await post(`/connect/cca-${RUN}/exchange`, {
      tok: minted.token,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.key).toBe("cca:u1"); // server-proven canonical key
    expect(body.platformUserId).toBe("u1");

    // The contact merged: externalId = platform key, email = the sealed address.
    const [row] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.email, email))
      .limit(1);
    expect(row?.externalId).toBe("cca:u1");

    // Single-use: the same token is now spent.
    const again = await post(`/connect/cca-${RUN}/exchange`, {
      tok: minted.token,
    });
    expect(again.status).toBe(410);
  });

  it("ignores identity fields in the body — ids come ONLY from the sealed token", async () => {
    const sealed = emailFor("sealed");
    const minted = await cca.mintConfirm({
      platformUserId: "u2",
      email: sealed,
    });
    if (!minted.ok) throw new Error("mint failed");

    // Attacker-style body naming a different email + platform id.
    const res = await post(`/connect/cca-${RUN}/exchange`, {
      tok: minted.token,
      email: emailFor("inject"),
      userId: "cca:evil",
      platformUserId: "evil",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).key).toBe("cca:u2"); // the SEALED id, not the body's

    // The injected email never became a contact.
    const injected = await db
      .select()
      .from(contacts)
      .where(eq(contacts.email, emailFor("inject")));
    expect(injected.length).toBe(0);
  });

  it("cross-connector isolation: a token minted for A cannot be redeemed on B's route", async () => {
    const minted = await cca.mintConfirm({
      platformUserId: "u3",
      email: emailFor("iso"),
    });
    if (!minted.ok) throw new Error("mint failed");
    // POST A's token to B's exchange — B keys Redis by its own connectorId, miss.
    const res = await post(`/connect/ccb-${RUN}/exchange`, {
      tok: minted.token,
    });
    expect(res.status).toBe(410);
  });

  it("afterBind throws → still 200, and the token is consumed (at-least-once, no stuck re-fire)", async () => {
    const before = afterBindRan;
    const minted = await ccThrow.mintConfirm({
      platformUserId: "u4",
      email: emailFor("throw"),
    });
    if (!minted.ok) throw new Error("mint failed");

    const res = await post(`/connect/ccx-${RUN}/exchange`, {
      tok: minted.token,
    });
    expect(res.status).toBe(200); // afterBind error is swallowed
    expect(afterBindRan).toBe(before + 1);

    // Token consumed despite the throw — a second click is spent, not re-firing.
    const again = await post(`/connect/ccx-${RUN}/exchange`, {
      tok: minted.token,
    });
    expect(again.status).toBe(410);
    expect(afterBindRan).toBe(before + 1); // did NOT run again
  });

  it("rejects a missing/invalid token", async () => {
    expect((await post(`/connect/cca-${RUN}/exchange`, {})).status).toBe(400);
    expect(
      (await post(`/connect/cca-${RUN}/exchange`, { tok: "nope" })).status,
    ).toBe(410);
  });

  it("GET the connect page is a pure render — it does NOT consume the token", async () => {
    const minted = await cca.mintConfirm({
      platformUserId: "u5",
      email: emailFor("get"),
    });
    if (!minted.ok) throw new Error("mint failed");

    const page = await app.request(`/connect/cca-${RUN}?tok=${minted.token}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");

    // The token still binds after the GET (GET wrote nothing).
    const res = await post(`/connect/cca-${RUN}/exchange`, {
      tok: minted.token,
    });
    expect(res.status).toBe(200);
  });

  it("page render hardens the inline <script>: escapes </script> in branding and fails closed on a malformed iconSvg", async () => {
    const page = await app.request(`/connect/cch-${RUN}?tok=anything`);
    expect(page.status).toBe(200);
    const html = await page.text();

    // The hostile title's </script> must not close the bootstrap early: exactly
    // one real </script> tag, and the breakout appears unicode-escaped instead.
    expect((html.match(/<\/script>/g) ?? []).length).toBe(1);
    expect(html).toContain("\\u003c/script\\u003e");

    // The malformed iconSvg is never raw-inlined; the emoji badge is used instead.
    expect(html).not.toContain("onerror");
    expect(html).toContain('"badge":"✈️"');
  });
});
