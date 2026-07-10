import { afterAll, describe, expect, it, vi } from "vitest";

// DB-touching lib test: point at the real docker TimescaleDB (mirrors the other
// data-plane tests), overriding the vitest.config placeholder DATABASE_URL. This
// MUST be set before `createDatabase({ url: process.env.DATABASE_URL })` runs.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// `@hogsend/engine`'s index constructs the Hatchet client at import; stub it so
// importing `readRecipientPreferences` never dials a live gRPC engine. This suite
// only exercises a pure DB read — there is no hatchet interaction to preserve.
vi.mock("../../../../packages/engine/src/lib/hatchet.ts", () => ({
  hatchet: {
    durableTask: vi.fn(() => ({
      run: vi.fn(),
      runNoWait: vi.fn(),
      runAndWait: vi.fn(),
    })),
    task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
    events: { push: vi.fn() },
    runs: { cancel: vi.fn(), get: vi.fn() },
    worker: vi.fn(),
  },
}));

const { createDatabase, emailPreferences } = await import("@hogsend/db");
const { like } = await import("drizzle-orm");
const { readRecipientPreferences } = await import("@hogsend/engine");

const { db, client } = createDatabase({ url: process.env.DATABASE_URL });

// RUN-namespaced identities so rows never collide with a concurrent suite (all
// DB-backed suites share ONE docker TimescaleDB). Unique per-test emails avoid
// cross-test interference within this file too.
const RUN = `prefread-${Date.now()}`;

afterAll(async () => {
  await db
    .delete(emailPreferences)
    .where(like(emailPreferences.email, `${RUN}%`));
  await client.end();
});

describe("readRecipientPreferences", () => {
  it("aggregates unsubscribedAll across multiple rows for one address", async () => {
    // Row A keyed (email, email) — an unsubscribe imported before the contact
    // existed. Row B keyed (external_id, email) — a later, CLEAN interactive
    // write. The import must NOT be shadowed by the newer clean row.
    const email = `${RUN}-multi@example.com`;
    await db.insert(emailPreferences).values([
      { userId: email, email, unsubscribedAll: true },
      { userId: `${RUN}-ext-multi`, email, unsubscribedAll: false },
    ]);

    const prefs = await readRecipientPreferences(db, { email });
    expect(prefs.unsubscribedAll).toBe(true);
    expect(prefs.suppressed).toBe(false);
  });

  it("merges category maps with explicit false winning", async () => {
    // Two rows for the same address disagree on category `x`; the opt-out (false)
    // on ANY row must win the merge.
    const email = `${RUN}-cat@example.com`;
    await db.insert(emailPreferences).values([
      { userId: email, email, categories: { x: true } },
      { userId: `${RUN}-ext-cat`, email, categories: { x: false } },
    ]);

    const prefs = await readRecipientPreferences(db, { email });
    expect(prefs.categories.x).toBe(false);
  });

  it("flags suppressed when ANY row is suppressed", async () => {
    const email = `${RUN}-supp@example.com`;
    await db.insert(emailPreferences).values([
      { userId: email, email, suppressed: false },
      { userId: `${RUN}-ext-supp`, email, suppressed: true },
    ]);

    const prefs = await readRecipientPreferences(db, { email });
    expect(prefs.suppressed).toBe(true);
    expect(prefs.unsubscribedAll).toBe(false);
  });

  it("finds a row via the userId-only leg (email undefined)", async () => {
    // Row keyed (external_id, email); reading by userId alone must still match it.
    const extId = `${RUN}-ext-only`;
    const email = `${RUN}-useridonly@example.com`;
    await db
      .insert(emailPreferences)
      .values({ userId: extId, email, unsubscribedAll: true });

    const prefs = await readRecipientPreferences(db, { userId: extId });
    expect(prefs.unsubscribedAll).toBe(true);
  });

  it("aggregates BOTH legs when a person is split across keys (OR semantics)", async () => {
    // Row A is reachable only by email; row B only by userId. A read supplying
    // both keys must union them and surface each row's signal.
    const emailA = `${RUN}-orA@example.com`;
    const userB = `${RUN}-orB-ext`;
    const emailB = `${RUN}-orB@example.com`;
    await db.insert(emailPreferences).values([
      { userId: `${RUN}-orA-ext`, email: emailA, suppressed: true },
      { userId: userB, email: emailB, unsubscribedAll: true },
    ]);

    const prefs = await readRecipientPreferences(db, {
      email: emailA,
      userId: userB,
    });
    expect(prefs.suppressed).toBe(true); // from row A (matched by email)
    expect(prefs.unsubscribedAll).toBe(true); // from row B (matched by userId)
  });

  it("returns clean defaults without querying when neither key is provided", async () => {
    const prefs = await readRecipientPreferences(db, {});
    expect(prefs).toEqual({
      unsubscribedAll: false,
      suppressed: false,
      categories: {},
    });
  });

  it("treats null / empty-string keys as absent", async () => {
    // An empty-string email must NOT match every `email = ''`-ish row, and a
    // null userId contributes no leg — so this behaves like the neither-key case.
    const prefs = await readRecipientPreferences(db, {
      email: "",
      userId: null,
    });
    expect(prefs).toEqual({
      unsubscribedAll: false,
      suppressed: false,
      categories: {},
    });
  });
});
