/**
 * PRD 05 stage 1 - the `shared` link type.
 *
 * A `shared` link is owned by a person (`links.owner_contact_id`) and clicked
 * by SOMEONE ELSE. It therefore sits on the PUBLIC side of the share-safe
 * invariant: it attributes to its owner and stitches nobody. Reusing
 * `personal` for a referral link would identify every referee AS the referrer,
 * which is exactly the failure mode the invariant exists to prevent - so the
 * click assertions below are the load-bearing ones, not the throw assertions.
 */
import type { HogsendClient } from "@hogsend/engine";
import { afterAll, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const {
  contacts,
  linkClicks,
  links,
  referralTouches,
  trackedLinks,
  userEvents,
} = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");
const {
  createApp,
  createHogsendClient,
  LinkOwnershipError,
  mintLink,
  SlugTakenError,
} = await import("@hogsend/engine");

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

const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const app = createApp(container);
const { db } = container;

const RUN = `shared-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const mintedLinkIds: string[] = [];
const contactIds: string[] = [];

async function makeContact(): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values({ externalId: `${RUN}-owner-${contactIds.length}` })
    .returning({ id: contacts.id });
  if (!row) throw new Error("contact insert failed");
  contactIds.push(row.id);
  return row.id;
}

afterAll(async () => {
  for (const id of mintedLinkIds) {
    const tracked = await db
      .select({ id: trackedLinks.id })
      .from(trackedLinks)
      .where(eq(trackedLinks.linkId, id));
    for (const t of tracked) {
      await db.delete(linkClicks).where(eq(linkClicks.trackedLinkId, t.id));
    }
    await db.delete(trackedLinks).where(eq(trackedLinks.linkId, id));
    await db.delete(links).where(eq(links.id, id));
  }
  for (const id of contactIds) {
    await db.delete(contacts).where(eq(contacts.id, id));
  }
});

it("exports the referral_touches table from @hogsend/db", () => {
  // The schema export is what every later stage imports; a missing barrel line
  // is otherwise only discovered by the first store write.
  expect(referralTouches).toBeDefined();
  expect(referralTouches.refereeKey).toBeDefined();
  expect(referralTouches.referrerContactId).toBeDefined();
});

it('type "shared" requires an ownerContactId', async () => {
  await expect(
    mintLink({
      db,
      baseUrl: "http://localhost:3002",
      url: "https://example.com/shared-no-owner",
      type: "shared",
      source: "test",
    }),
  ).rejects.toBeInstanceOf(LinkOwnershipError);
});

it("ownerContactId on a public or personal link throws", async () => {
  const ownerId = await makeContact();
  for (const type of ["public", "personal"] as const) {
    await expect(
      mintLink({
        db,
        baseUrl: "http://localhost:3002",
        url: `https://example.com/owner-on-${type}`,
        type,
        ownerContactId: ownerId,
        source: "test",
      }),
    ).rejects.toBeInstanceOf(LinkOwnershipError);
  }
});

it("a shared link stores its owner and carries NO distinctId", async () => {
  const ownerId = await makeContact();
  const minted = await mintLink({
    db,
    baseUrl: "http://localhost:3002",
    url: "https://example.com/shared-owner",
    type: "shared",
    ownerContactId: ownerId,
    // Deliberately passed: a shared link must DROP it, exactly as a public
    // link does. If this ever survives, every referee is stitched to the
    // referrer's identity.
    distinctId: `${RUN}-should-be-dropped`,
    source: "referral",
  });
  mintedLinkIds.push(minted.linkId);

  expect(minted.type).toBe("shared");
  expect(minted.ownerContactId).toBe(ownerId);

  const [row] = await db
    .select()
    .from(links)
    .where(eq(links.id, minted.linkId))
    .limit(1);
  expect(row?.type).toBe("shared");
  expect(row?.ownerContactId).toBe(ownerId);
  expect(row?.distinctId).toBeNull();

  const [tracked] = await db
    .select()
    .from(trackedLinks)
    .where(eq(trackedLinks.linkId, minted.linkId))
    .limit(1);
  expect(tracked?.distinctId).toBeNull();
});

it("a click on a shared link stitches nobody and mints no hs_t", async () => {
  const ownerId = await makeContact();
  const minted = await mintLink({
    db,
    baseUrl: "http://localhost:3002",
    url: "https://example.com/shared-click",
    type: "shared",
    ownerContactId: ownerId,
    distinctId: `${RUN}-dropped-click`,
    source: "referral",
  });
  mintedLinkIds.push(minted.linkId);

  const res = await app.request(`/v1/t/c/${minted.trackedLinkId}`, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
    redirect: "manual",
  });

  expect(res.status).toBe(302);
  const location = res.headers.get("location") ?? "";
  // The redirect must carry NO identity token. `hs_t` is the single-use
  // cross-device identity handoff; on a link anyone can reshare it would hand
  // the referrer's identity to whoever clicked.
  expect(location.startsWith("https://example.com/shared-click")).toBe(true);
  expect(location).not.toContain("hs_t");

  // And the click recorded no person: the bus re-ingest is gated on the link's
  // `distinctId`, which a shared link never has.
  const [click] = await db
    .select()
    .from(linkClicks)
    .where(eq(linkClicks.trackedLinkId, minted.trackedLinkId))
    .limit(1);
  expect(click).toBeDefined();

  const events = await db
    .select({ id: userEvents.id })
    .from(userEvents)
    .where(eq(userEvents.userId, `${RUN}-dropped-click`));
  expect(events).toHaveLength(0);
});

it("a slug collision between two owners is a conflict, not a silent recovery", async () => {
  const a = await makeContact();
  const b = await makeContact();
  const slug = `${RUN}-collide`.toLowerCase();
  const url = "https://example.com/shared-collide";
  const first = await mintLink({
    db,
    baseUrl: "http://localhost:3002",
    url,
    type: "shared",
    ownerContactId: a,
    source: "referral",
    slug,
  });
  mintedLinkIds.push(first.linkId);

  // Same owner + same destination + same slug: idempotent recovery.
  const again = await mintLink({
    db,
    baseUrl: "http://localhost:3002",
    url,
    type: "shared",
    ownerContactId: a,
    source: "referral",
    slug,
  });
  expect(again.linkId).toBe(first.linkId);

  // A DIFFERENT owner colliding on the slug must not inherit A's link,
  // or every touch on B's "link" would credit A.
  await expect(
    mintLink({
      db,
      baseUrl: "http://localhost:3002",
      url,
      type: "shared",
      ownerContactId: b,
      source: "referral",
      slug,
    }),
  ).rejects.toThrow(SlugTakenError);
});
