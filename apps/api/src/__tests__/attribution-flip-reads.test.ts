/**
 * PRD 05 T8 — attribution + revenue read history by SUBJECT, not by string key.
 *
 * The batch's three flipped reads all answer one question — "what did this
 * PERSON do before they converted?" — and all three used to ask it of a mutable
 * text key. That is the worst possible key for this subsystem: a touchpoint
 * path is, by definition, mostly ANONYMOUS. The ad click, the campaign landing,
 * the first link — every one of them is written under a key the visitor stops
 * carrying the moment they register. A `user_id`-scoped read therefore drops
 * the whole pre-identification half of the path and credits the sale to
 * nothing.
 *
 * Five behaviours, one per arm of `bySubject` on each flipped site:
 *
 *   (a) `recordAttributionCredits` (`lib/attribution.ts`), CONTACT arm across a
 *       key divergence — the touchpoints sit under a STALE anonymous key the
 *       conversion never carries. Driven through the REAL path
 *       (`ingestEvent` → `evaluateConversionsAtIngest` → the ledger), so it
 *       also covers the ingest call site the required `contactId` added. The
 *       assertion is red before the flip by construction: a `user_id`-scoped
 *       read of the canonical key finds NO touchpoints, so the ledger comes out
 *       empty rather than merely different.
 *
 *   (b) `getContactRevenue` (`lib/revenue.ts`), CONTACT arm across the same
 *       divergence — the admin contact page's revenue rollup. Proved with an
 *       explicit control: the SAME call with `contactId: null` is the pre-flip
 *       read verbatim, and is asserted to report the smaller number.
 *
 *   (c) `recoverClickContext` (`lib/conversion-dispatch.ts`), CONTACT arm — the
 *       ad-platform leg, with the same null-contact control. The `gclid` lives
 *       on the anonymous arrival by construction, so this is the site where the
 *       string key is GUARANTEED to be the wrong one.
 *
 *   (d) The userKey arm — a subject with NO contact at all (the engine refuses
 *       to mint one on observation) must still have its revenue summed and its
 *       click context recovered. This is the population a naive
 *       `eq(contact_id, …)` flip strands forever.
 *
 *   (e) `backfillAttributionBatch` (`lib/attribution-backfill.ts`), CONTACT arm
 *       — the same divergence, but replayed retroactively through the admin
 *       batch endpoint. The backfill scopes by the owner ONLY when the trigger
 *       spine row carries the `contact_id` stamp; the pre-upgrade case (an
 *       unstamped spine, which no contact-scoped scan can reach) keeps the
 *       string key and is covered by `attribution-backfill.test.ts`.
 *
 * Why the fixtures stamp `contact_id` with a direct UPDATE instead of calling
 * `resolveOrCreateContact`: adoption today does BOTH halves — it stamps
 * `contact_id` AND rewrites `user_id` onto the new canonical key — so a
 * resolve-driven fixture would leave the rows reachable by the string key and
 * the flip would become unobservable (a test that certifies rather than tests).
 * The UPDATE below is PRD 05 D4's adoption statement verbatim
 * (`SET contact_id = :id WHERE user_id = :staleKey AND contact_id IS NULL`) —
 * the shape T9 makes permanent once the string rewrite is deleted.
 *
 * Fixture law: every identity value is run-namespaced; each behaviour owns its
 * own key pair and contact, so nothing here depends on another test having run;
 * every stale key is one NO contact owns (so this suite's backfill sweep can
 * never stamp a fixture out from under it, and no row is ever "owned-but-NULL");
 * and no assertion counts rows outside this run's namespace.
 */
import { randomUUID } from "node:crypto";
import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

// DB-touching test. The DEFAULT below is the repo-wide one every file in this
// directory shares, and it is what CI's service container listens on. Point a
// worktree at its own stack by exporting HOGSEND_TEST_DATABASE_URL — never by
// editing the default.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { attributionCredits, contacts, conversions, userEvents } = await import(
  "@hogsend/db"
);
const { and, eq, inArray, isNull } = await import("drizzle-orm");
const {
  createApp,
  createHogsendClient,
  defineConversion,
  getContactRevenue,
  ingestEvent,
  recoverClickContext,
  resolveOrCreateContact,
} = await import("@hogsend/engine");

const RUN = `t8flip-${randomUUID()}`;
const uid = (label: string) => `${RUN}-${label}`;

// (a) — the ledger: the anon-era key the path is on vs. the key it converts on.
const A_STALE = uid("a-stale");
const A_CURRENT = uid("a-current");

// (b) — the revenue rollup, same divergence.
const B_STALE = uid("b-stale");
const B_CURRENT = uid("b-current");

// (c) — the ad click id, which only ever exists on the anonymous arrival.
const C_STALE = uid("c-stale");
const C_CURRENT = uid("c-current");

// (d) — a subject that never becomes a contact.
const D_ANON = uid("d-anon");

// (e) — the same divergence, replayed by the attribution BACKFILL.
const E_STALE = uid("e-stale");
const E_CURRENT = uid("e-current");

const ARRIVED_AT = new Date("2026-06-08T09:00:00Z");
const CLICKED_AT = new Date("2026-06-09T09:00:00Z");
const CONVERTED_AT = new Date("2026-06-10T12:00:00Z");

const ALL_KEYS = [
  A_STALE,
  A_CURRENT,
  B_STALE,
  B_CURRENT,
  C_STALE,
  C_CURRENT,
  D_ANON,
  E_STALE,
  E_CURRENT,
];

/** (a) is driven end-to-end, so the ledger writer needs a live definition. */
const SALE_DEFINITION = uid("sale");
const saleConversion = defineConversion({
  id: SALE_DEFINITION,
  trigger: { event: "deal.sold" },
  attributionWindowDays: 30,
});

/** (e) replays history, so it needs a trigger of its own to scope the batch. */
const BACKFILL_DEFINITION = uid("backfill");
const BACKFILL_TRIGGER = `${RUN}.order`;
const backfillConversion = defineConversion({
  id: BACKFILL_DEFINITION,
  trigger: { event: BACKFILL_TRIGGER },
  attributionWindowDays: 30,
});

// A live Hatchet engine must never be reached from a unit suite; `ingestEvent`
// pushes every event and rethrows on a failed push, so the spy has to resolve.
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

const container = createHogsendClient({
  conversions: [saleConversion, backfillConversion],
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db, registry, hatchet, logger } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

const createdContactIds: string[] = [];

afterAll(async () => {
  // The `user_events` delete below cascades conversions (eventId FK) and their
  // credits, which also sweeps any built-in `revenue` rows these fixtures fire.
  const convRows = await db
    .select({ id: conversions.id })
    .from(conversions)
    .where(
      inArray(conversions.definitionId, [SALE_DEFINITION, BACKFILL_DEFINITION]),
    );
  const convIds = convRows.map((row) => row.id);
  if (convIds.length > 0) {
    await db
      .delete(attributionCredits)
      .where(inArray(attributionCredits.conversionId, convIds));
    await db.delete(conversions).where(inArray(conversions.id, convIds));
  }
  await db.delete(userEvents).where(inArray(userEvents.userId, ALL_KEYS));
  if (createdContactIds.length > 0) {
    await db.delete(contacts).where(inArray(contacts.id, createdContactIds));
  }
});

/** Insert one raw spine row; returns its id. */
async function seedEvent(opts: {
  userId: string;
  event: string;
  occurredAt: Date;
  /** The dual-write stamp `ingestEvent` makes; omit for the anonymous era. */
  contactId?: string;
  value?: number;
  currency?: string;
  properties?: Record<string, unknown>;
}): Promise<string> {
  const [row] = await db
    .insert(userEvents)
    .values({
      userId: opts.userId,
      event: opts.event,
      occurredAt: opts.occurredAt,
      source: "api",
      ...(opts.contactId !== undefined ? { contactId: opts.contactId } : {}),
      ...(opts.value !== undefined ? { value: opts.value } : {}),
      ...(opts.currency !== undefined ? { currency: opts.currency } : {}),
      ...(opts.properties !== undefined ? { properties: opts.properties } : {}),
    })
    .returning({ id: userEvents.id });
  if (!row) throw new Error("userEvents insert returned no row");
  return row.id;
}

/** PRD 05 D4's adoption statement: stamp ownership, leave `user_id` alone. */
async function stampOwnership(staleKey: string, contactId: string) {
  await db
    .update(userEvents)
    .set({ contactId })
    .where(and(eq(userEvents.userId, staleKey), isNull(userEvents.contactId)));
}

/** Mint the contact this behaviour's canonical key belongs to. */
async function mintContact(userId: string): Promise<string> {
  const contact = await resolveOrCreateContact({ db, userId });
  createdContactIds.push(contact.id);
  return contact.id;
}

describe("T8 — the attribution ledger follows the CONTACT across a key divergence", () => {
  it("credits touchpoints keyed on the adopted stale key when the conversion arrives under the canonical key", async () => {
    // (1) The anonymous era: an ad arrival and a link click under A_STALE, with
    // no contact anywhere in existence.
    const arrivedId = await seedEvent({
      userId: A_STALE,
      event: "campaign.arrived",
      occurredAt: ARRIVED_AT,
      properties: { gclid: `${RUN}-a-gclid` },
    });
    const clickedId = await seedEvent({
      userId: A_STALE,
      event: "link.clicked",
      occurredAt: CLICKED_AT,
    });

    // (2) Registration mints the contact under a DIFFERENT canonical key, and
    // adoption stamps the anon-era path onto it WITHOUT rewriting `user_id`.
    // From here the touchpoints are reachable only by `contact_id`.
    const contactId = await mintContact(A_CURRENT);
    await stampOwnership(A_STALE, contactId);

    // (3) The sale fires under the canonical key, through the real pipeline.
    await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      event: {
        event: "deal.sold",
        userId: A_CURRENT,
        eventProperties: {},
        value: 400,
        currency: "GBP",
        occurredAt: CONVERTED_AT.toISOString(),
        idempotencyKey: `${RUN}:a:deal.sold`,
        source: "crm",
      },
    });

    const [conversion] = await db
      .select({ id: conversions.id, contactId: conversions.contactId })
      .from(conversions)
      .where(eq(conversions.definitionId, SALE_DEFINITION));
    if (!conversion) throw new Error("expected the sale conversion to fire");
    expect(conversion.contactId).toBe(contactId);

    // (4) The ledger. Pre-flip this scan was `user_id = A_CURRENT`, which
    // matches NEITHER touchpoint — the sale would be credited to nothing and
    // this table would be empty.
    const credits = await db
      .select({
        model: attributionCredits.model,
        touchpointEventId: attributionCredits.touchpointEventId,
        channel: attributionCredits.channel,
      })
      .from(attributionCredits)
      .where(eq(attributionCredits.conversionId, conversion.id));
    expect(credits.length).toBeGreaterThan(0);
    const credited = [...new Set(credits.map((row) => row.touchpointEventId))];
    expect(credited.sort()).toEqual([arrivedId, clickedId].sort());
    expect(new Set(credits.map((row) => row.channel))).toEqual(
      new Set(["campaign", "link"]),
    );

    // `first` / `last` pin WHICH touch won, so losing the ORDER of the adopted
    // path is a distinct failure this fixture still catches.
    const first = credits.filter((row) => row.model === "first");
    expect(first).toHaveLength(1);
    expect(first[0]?.touchpointEventId).toBe(arrivedId);
    const last = credits.filter((row) => row.model === "last");
    expect(last).toHaveLength(1);
    expect(last[0]?.touchpointEventId).toBe(clickedId);
  });
});

describe("T8 — the revenue rollup follows the CONTACT across a key divergence", () => {
  it("sums valued events keyed on the adopted stale key when read under the canonical key", async () => {
    // (1) An anon-era purchase, then registration under a different key, then
    // the adoption stamp.
    await seedEvent({
      userId: B_STALE,
      event: "order.completed",
      occurredAt: ARRIVED_AT,
      value: 250,
      currency: "GBP",
    });
    const contactId = await mintContact(B_CURRENT);
    await stampOwnership(B_STALE, contactId);

    // (2) A second, identified purchase — dual-written exactly as ingest
    // writes it, so the rollup has to aggregate across BOTH eras.
    await seedEvent({
      userId: B_CURRENT,
      event: "deal.sold",
      occurredAt: CONVERTED_AT,
      contactId,
      value: 400,
      currency: "GBP",
    });

    // The pre-flip read sees only the canonical key's own sale; the anonymous
    // era's £250 is invisible and the contact looks worth less than they are.
    const preFlip = await getContactRevenue({
      db,
      key: B_CURRENT,
      contactId: null,
    });
    expect(preFlip.totals).toEqual([{ currency: "GBP", total: 400, count: 1 }]);

    // The flipped read: the whole person, both eras.
    const flipped = await getContactRevenue({ db, key: B_CURRENT, contactId });
    expect(flipped.totals).toEqual([{ currency: "GBP", total: 650, count: 2 }]);
    expect(flipped.lastValuedAt).toBe(CONVERTED_AT.toISOString());
  });
});

describe("T8 — click context follows the CONTACT across a key divergence", () => {
  it("recovers the click id from an arrival keyed on the adopted stale key", async () => {
    const gclid = `${RUN}-c-gclid`;
    await seedEvent({
      userId: C_STALE,
      event: "campaign.arrived",
      occurredAt: ARRIVED_AT,
      properties: { gclid, landing_page: "https://example.test/pricing" },
    });
    const contactId = await mintContact(C_CURRENT);
    await stampOwnership(C_STALE, contactId);

    // Pre-flip: the ad click is anonymous by construction, so scoping to the
    // post-registration key loses the one identifier the platform matches on
    // — the dispatch goes out unattributable.
    const preFlip = await recoverClickContext({
      db,
      userKey: C_CURRENT,
      contactId: null,
      before: CONVERTED_AT,
    });
    expect(preFlip).toEqual({ clickIds: {} });

    const flipped = await recoverClickContext({
      db,
      userKey: C_CURRENT,
      contactId,
      before: CONVERTED_AT,
    });
    expect(flipped.clickIds).toEqual({ gclid });
    expect(flipped.clickAt).toBe(ARRIVED_AT.getTime());
    expect(flipped.landingPage).toBe("https://example.test/pricing");
  });
});

describe("T8 — the contactless arm still reads", () => {
  it("sums revenue and recovers click context for a subject that owns no contact", async () => {
    const fbclid = `${RUN}-d-fbclid`;
    await seedEvent({
      userId: D_ANON,
      event: "campaign.arrived",
      occurredAt: ARRIVED_AT,
      properties: { fbclid },
    });
    await seedEvent({
      userId: D_ANON,
      event: "deal.sold",
      occurredAt: CONVERTED_AT,
      value: 99,
      currency: "USD",
    });

    // No contact exists for this key — the engine refuses to mint one on
    // observation — so `bySubject` must fall back to the text key. A read that
    // only ever looked at `contact_id` would report this person as having done
    // nothing, forever.
    const revenue = await getContactRevenue({
      db,
      key: D_ANON,
      contactId: null,
    });
    expect(revenue.totals).toEqual([{ currency: "USD", total: 99, count: 1 }]);

    const clicks = await recoverClickContext({
      db,
      userKey: D_ANON,
      contactId: null,
      before: CONVERTED_AT,
    });
    expect(clicks.clickIds).toEqual({ fbclid });

    // And the key really is contactless: nothing minted a row behind our back.
    const owners = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.externalId, D_ANON));
    expect(owners).toHaveLength(0);
  });
});

describe("T8 — the attribution backfill follows the CONTACT across a key divergence", () => {
  it("credits a replayed conversion against touchpoints keyed on the adopted stale key", async () => {
    // The anon-era touch, then registration elsewhere, then adoption.
    const touchId = await seedEvent({
      userId: E_STALE,
      event: "email.link_clicked",
      occurredAt: ARRIVED_AT,
      properties: { journeyId: `${RUN}-e-journey` },
    });
    const contactId = await mintContact(E_CURRENT);
    await stampOwnership(E_STALE, contactId);

    // The historical sale, written straight to the spine (never evaluated) but
    // STAMPED — i.e. a deploy whose `contact_id` backfill has already run and
    // which is now replaying its conversions.
    await seedEvent({
      userId: E_CURRENT,
      event: BACKFILL_TRIGGER,
      occurredAt: CONVERTED_AT,
      contactId,
      value: 500,
      currency: "GBP",
    });

    // Loop the batch endpoint to completion, exactly like the CLI does.
    let cursor: string | undefined;
    const totals = { conversionsFired: 0, creditsWritten: 0 };
    for (let i = 0; i < 50 && (i === 0 || cursor); i++) {
      const res = await app.request("/v1/admin/attribution/backfill", {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({
          definitionId: BACKFILL_DEFINITION,
          limit: 100,
          cursor,
        }),
      });
      expect(res.status).toBe(200);
      const batch = (await res.json()) as {
        conversionsFired: number;
        creditsWritten: number;
        nextCursor: string | null;
      };
      totals.conversionsFired += batch.conversionsFired;
      totals.creditsWritten += batch.creditsWritten;
      cursor = batch.nextCursor ?? undefined;
    }
    expect(totals).toEqual({ conversionsFired: 1, creditsWritten: 1 });

    // The replayed sale is credited to the anon-era touch. A `user_id`-scoped
    // scan of the canonical key finds nothing, so `creditsWritten` would be 0
    // and this table empty.
    const [conversion] = await db
      .select({ id: conversions.id })
      .from(conversions)
      .where(eq(conversions.definitionId, BACKFILL_DEFINITION));
    if (!conversion)
      throw new Error("expected the replayed conversion to fire");
    const credits = await db
      .select({ touchpointEventId: attributionCredits.touchpointEventId })
      .from(attributionCredits)
      .where(eq(attributionCredits.conversionId, conversion.id));
    expect(credits.length).toBeGreaterThan(0);
    expect(new Set(credits.map((row) => row.touchpointEventId))).toEqual(
      new Set([touchId]),
    );
  });
});
