/**
 * PRD 05 stages 3 + 4 - the referral LIFECYCLE, end to end against a real DB.
 *
 * The load-bearing assertions here are the identity ones, not the happy path:
 *
 *  - a cold touch records the visitor's ANONYMOUS id and mints NO contact
 *    (observation is not identity - PRD 02's ghost-contact law);
 *  - the bind happens at identity ADOPTION, keyed on that same anon string;
 *  - a self-referral is refused because the merge says so, not because a fraud
 *    heuristic guessed;
 *  - with no referral registered, a `shared` link click is inert.
 *
 * Emits are fire-and-forget on both planes, so every fact assertion polls
 * `user_events` (the journey plane's durable trace) rather than racing it.
 */
import type { HogsendClient } from "@hogsend/engine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const {
  contacts,
  conversions,
  linkClicks,
  links,
  referralTouches,
  trackedLinks,
  userEvents,
} = await import("@hogsend/db");
const { and, eq, inArray, like } = await import("drizzle-orm");
const { days } = await import("@hogsend/core");
const {
  convertReferral,
  createApp,
  createHogsendClient,
  defineReferral,
  getReferralLink,
  resolveOrCreateContact,
  touchReferral,
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

const RUN = `ref-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const invite = defineReferral({
  id: "invite",
  link: { destination: "https://example.com/join", campaign: "invite" },
  qualify: { event: "subscription.started" },
  bindWindow: days(30),
});
/** No `qualify` block: bind IS qualify. */
const bare = defineReferral({
  id: "bare",
  link: { destination: "https://example.com/bare" },
});

const container = createHogsendClient({
  referrals: [invite, bare],
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db } = container;

const linkIds: string[] = [];
const contactIds: string[] = [];
const conversionIds: string[] = [];

async function makeContact(label: string): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values({
      externalId: `${RUN}-${label}`,
      email: `${RUN}-${label}@example.test`,
    })
    .returning({ id: contacts.id });
  if (!row) throw new Error("contact insert failed");
  contactIds.push(row.id);
  return row.id;
}

const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Click the link as an anonymous human; returns the appended `hs_ref`. */
async function clickAndGetRef(trackedLinkId: string): Promise<string> {
  const res = await app.request(`/v1/t/c/${trackedLinkId}`, {
    headers: { "User-Agent": CHROME },
    redirect: "manual",
  });
  expect(res.status).toBe(302);
  const location = res.headers.get("location") ?? "";
  const ref = new URL(location).searchParams.get("hs_ref");
  if (!ref) throw new Error(`no hs_ref appended to ${location}`);
  return ref;
}

async function arrive(ref: string, anonymousId: string): Promise<void> {
  const res = await app.request("/v1/t/arrive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref, anonymousId }),
  });
  expect(res.status).toBe(200);
}

/** Poll until `read()` returns something truthy, or fail loudly. */
async function waitFor<T>(
  read: () => Promise<T | undefined | null>,
  what: string,
): Promise<T> {
  for (let i = 0; i < 60; i++) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function touchesFor(referrerContactId: string) {
  return db
    .select()
    .from(referralTouches)
    .where(eq(referralTouches.referrerContactId, referrerContactId));
}

/** The journey-plane trace for a referral fact. */
async function busEvents(event: string, userKey: string) {
  return db
    .select({ id: userEvents.id, properties: userEvents.properties })
    .from(userEvents)
    .where(and(eq(userEvents.event, event), eq(userEvents.userId, userKey)));
}

beforeAll(() => {
  // The engine's own boot warning noise is not what this file is testing.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterAll(async () => {
  await db
    .delete(referralTouches)
    .where(
      inArray(
        referralTouches.referrerContactId,
        contactIds.length
          ? contactIds
          : ["00000000-0000-0000-0000-000000000000"],
      ),
    );
  for (const id of conversionIds) {
    await db.delete(conversions).where(eq(conversions.id, id));
  }
  for (const id of linkIds) {
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
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}%`));
  for (const id of contactIds) {
    await db.delete(userEvents).where(eq(userEvents.contactId, id));
    await db.delete(contacts).where(eq(contacts.id, id));
  }
});

describe("getReferralLink", () => {
  it("mints ONE shared link per referrer, idempotently", async () => {
    const referrer = await makeContact("mint-owner");
    const first = await getReferralLink({
      referral: "invite",
      contactId: referrer,
      container,
    });
    linkIds.push(first.linkId);
    expect(first.existing).toBe(false);

    const [row] = await db
      .select()
      .from(links)
      .where(eq(links.id, first.linkId))
      .limit(1);
    expect(row?.type).toBe("shared");
    expect(row?.ownerContactId).toBe(referrer);
    expect(row?.referralId).toBe("invite");
    expect(row?.campaign).toBe("invite");
    // Arrival attribution is what makes a COLD touch possible at all - the
    // click carries no clicker key, so the referee's anon id only appears when
    // the landing page reports `hs_ref` back.
    expect(row?.appendRef).toBe(true);
    // Never a person token: a shared link is clicked by SOMEONE ELSE.
    expect(row?.distinctId).toBeNull();

    // A journey calling this on every run must not mint a second link.
    const again = await getReferralLink({
      referral: "invite",
      contactId: referrer,
      container,
    });
    expect(again.linkId).toBe(first.linkId);
    expect(again.existing).toBe(true);
  });

  it("throws a named error for an unregistered referral", async () => {
    const referrer = await makeContact("mint-unknown");
    await expect(
      getReferralLink({ referral: "nope", contactId: referrer, container }),
    ).rejects.toThrow(/no referral "nope" is registered/);
  });

  it("derives a vanity slug and returns the vanity url", async () => {
    const slugged = defineReferral({
      id: "slugged",
      link: {
        destination: "https://example.com/slugged",
        slugFrom: () => `${RUN}-vanity`.toLowerCase(),
      },
    });
    const referrer = await makeContact("mint-slug");
    const minted = await getReferralLink({
      referral: slugged,
      contactId: referrer,
      container,
    });
    linkIds.push(minted.linkId);
    expect(minted.slug).toBe(`${RUN}-vanity`.toLowerCase());
    expect(minted.url).toContain(`/l/${minted.slug}`);
  });
});

describe("touch", () => {
  it("records the anon key and mints NO contact", async () => {
    const referrer = await makeContact("touch-owner");
    const link = await getReferralLink({
      referral: "invite",
      contactId: referrer,
      container,
    });
    linkIds.push(link.linkId);

    const anonId = `${RUN}-anon-cold`;
    const ref = await clickAndGetRef(link.trackedLinkId);

    // A click ALONE writes no touch: a shared link stitches nobody, so at
    // click time there is no key for the CLICKER. Inventing one would mint an
    // edge to a person who never arrives.
    expect(await touchesFor(referrer)).toHaveLength(0);

    await arrive(ref, anonId);

    const [touch] = await waitFor(async () => {
      const rows = await touchesFor(referrer);
      return rows.length > 0 ? rows : null;
    }, "the referral touch");
    expect(touch?.refereeKey).toBe(anonId);
    expect(touch?.refereeContactId).toBeNull();
    expect(touch?.status).toBe("touched");
    expect(touch?.clickId).toBe(ref);
    expect(touch?.referralId).toBe("invite");

    // THE GHOST-CONTACT LAW: an anonymous arrival is observation, not
    // identity. No `contacts` row may exist for that anon id, and above all
    // none with `external_id = <anonId>`.
    const minted = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.externalId, anonId));
    expect(minted).toHaveLength(0);
    const asAnon = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.anonymousId, anonId));
    expect(asAnon).toHaveLength(0);

    // `referral.touched` reaches the REFERRER only - the referee is a browser
    // id, not a person to notify.
    await waitFor(async () => {
      const rows = await busEvents("referral.touched", `${RUN}-touch-owner`);
      return rows.length > 0 ? rows : null;
    }, "referral.touched on the bus");
  });

  it("a replayed arrival writes no second edge", async () => {
    const referrer = await makeContact("touch-replay");
    const link = await getReferralLink({
      referral: "invite",
      contactId: referrer,
      container,
    });
    linkIds.push(link.linkId);
    const anonId = `${RUN}-anon-replay`;
    const ref = await clickAndGetRef(link.trackedLinkId);
    await arrive(ref, anonId);
    await waitFor(async () => {
      const rows = await touchesFor(referrer);
      return rows.length > 0 ? rows : null;
    }, "the first touch");
    await arrive(ref, anonId);
    await new Promise((r) => setTimeout(r, 200));
    expect(await touchesFor(referrer)).toHaveLength(1);
  });

  it("is inert when the referral is not registered", async () => {
    // Same shape as a real referral link, but its `referral_id` names a
    // program this deploy does not define (deleted from code, say).
    const referrer = await makeContact("touch-unregistered");
    const { mintLink } = await import("@hogsend/engine");
    const minted = await mintLink({
      db,
      baseUrl: container.env.API_PUBLIC_URL,
      url: "https://example.com/orphaned",
      type: "shared",
      ownerContactId: referrer,
      source: "referral",
      referralId: "deleted-program",
      appendRef: true,
    });
    linkIds.push(minted.linkId);
    const ref = await clickAndGetRef(minted.trackedLinkId);
    await arrive(ref, `${RUN}-anon-unregistered`);
    await new Promise((r) => setTimeout(r, 200));
    expect(await touchesFor(referrer)).toHaveLength(0);
  });
});

describe("bind", () => {
  it("binds at identity adoption, keyed on the anon string", async () => {
    const referrer = await makeContact("bind-owner");
    const link = await getReferralLink({
      referral: "invite",
      contactId: referrer,
      container,
    });
    linkIds.push(link.linkId);
    const anonId = `${RUN}-anon-bind`;
    await arrive(await clickAndGetRef(link.trackedLinkId), anonId);
    await waitFor(async () => {
      const rows = await touchesFor(referrer);
      return rows.length > 0 ? rows : null;
    }, "the cold touch");

    // The visitor signs up: the SAME anon id arrives alongside a real identity.
    const referee = await resolveOrCreateContact({
      db,
      anonymousId: anonId,
      userId: `${RUN}-referee`,
      email: `${RUN}-referee@example.test`,
    });
    contactIds.push(referee.id);

    const bound = await waitFor(async () => {
      const [row] = await touchesFor(referrer);
      return row?.status === "bound" ? row : null;
    }, "the bind stamp");
    expect(bound.refereeContactId).toBe(referee.id);
    expect(bound.boundAt).not.toBeNull();

    // `referral.bound` reaches BOTH ends.
    await waitFor(async () => {
      const rows = await busEvents("referral.bound", `${RUN}-bind-owner`);
      return rows.length > 0 ? rows : null;
    }, "referral.bound for the referrer");
    await waitFor(async () => {
      const rows = await busEvents("referral.bound", `${RUN}-referee`);
      return rows.length > 0 ? rows : null;
    }, "referral.bound for the referee");
  });

  it("refuses a self-referral - the merge is the fraud check", async () => {
    const referrer = await makeContact("self-owner");
    const link = await getReferralLink({
      referral: "invite",
      contactId: referrer,
      container,
    });
    linkIds.push(link.linkId);
    const anonId = `${RUN}-anon-self`;
    await arrive(await clickAndGetRef(link.trackedLinkId), anonId);
    await waitFor(async () => {
      const rows = await touchesFor(referrer);
      return rows.length > 0 ? rows : null;
    }, "the self touch");

    // The anon session turns out to belong to the OWNER of the link.
    await resolveOrCreateContact({
      db,
      anonymousId: anonId,
      userId: `${RUN}-self-owner`,
    });

    const rejected = await waitFor(async () => {
      const [row] = await touchesFor(referrer);
      return row?.status === "rejected" ? row : null;
    }, "the self rejection");
    expect(rejected.rejectedReason).toBe("self");
    expect(rejected.refereeContactId).toBeNull();
  });

  it("a referral with no qualify config is EARNED at bind", async () => {
    const referrer = await makeContact("bare-owner");
    const link = await getReferralLink({
      referral: "bare",
      contactId: referrer,
      container,
    });
    linkIds.push(link.linkId);
    const anonId = `${RUN}-anon-bare`;
    await arrive(await clickAndGetRef(link.trackedLinkId), anonId);
    await waitFor(async () => {
      const rows = await touchesFor(referrer);
      return rows.length > 0 ? rows : null;
    }, "the bare touch");

    const referee = await resolveOrCreateContact({
      db,
      anonymousId: anonId,
      userId: `${RUN}-bare-referee`,
      email: `${RUN}-bare-referee@example.test`,
    });
    contactIds.push(referee.id);

    const qualified = await waitFor(async () => {
      const [row] = await touchesFor(referrer);
      return row?.status === "qualified" ? row : null;
    }, "bind == qualified");
    expect(qualified.qualifiedAt).not.toBeNull();
  });

  it("earns at bind for an ALREADY-identified toucher too", async () => {
    // The cold path is not the only one that binds: a token arrival, an invite
    // or a manual touch writes `bound` straight from `recordTouch`, and on a
    // no-qualify referral that touch is earned the same instant.
    const referrer = await makeContact("bare-warm-owner");
    const referee = await makeContact("bare-warm-referee");
    await touchReferral({
      db,
      hatchet: container.hatchet,
      registry: container.registry,
      logger: container.logger,
      referrals: container.referrals,
      referral: bare,
      referrerContactId: referrer,
      refereeKey: `${RUN}-bare-warm-referee`,
      refereeContactId: referee,
      source: "manual",
    });

    const qualified = await waitFor(async () => {
      const [row] = await touchesFor(referrer);
      return row?.status === "qualified" ? row : null;
    }, "warm bind == qualified");
    expect(qualified.qualifiedAt).not.toBeNull();
  });
});

describe("qualify", () => {
  it("promotes on the qualify event, exactly once", async () => {
    const referrer = await makeContact("qual-owner");
    const link = await getReferralLink({
      referral: "invite",
      contactId: referrer,
      container,
    });
    linkIds.push(link.linkId);
    const anonId = `${RUN}-anon-qual`;
    await arrive(await clickAndGetRef(link.trackedLinkId), anonId);
    await waitFor(async () => {
      const rows = await touchesFor(referrer);
      return rows.length > 0 ? rows : null;
    }, "the qualify touch");

    const referee = await resolveOrCreateContact({
      db,
      anonymousId: anonId,
      userId: `${RUN}-qual-referee`,
      email: `${RUN}-qual-referee@example.test`,
    });
    contactIds.push(referee.id);
    await waitFor(async () => {
      const [row] = await touchesFor(referrer);
      return row?.status === "bound" ? row : null;
    }, "the bind before qualify");

    const { ingestEvent } = await import("@hogsend/engine");
    await ingestEvent({
      db,
      registry: container.registry,
      hatchet: container.hatchet,
      logger: container.logger,
      event: {
        event: "subscription.started",
        userId: `${RUN}-qual-referee`,
        eventProperties: { plan: "pro" },
        idempotencyKey: `${RUN}-qual-1`,
      },
    });

    const qualified = await waitFor(async () => {
      const [row] = await touchesFor(referrer);
      return row?.status === "qualified" ? row : null;
    }, "the qualify stamp");
    const firstQualifiedAt = qualified.qualifiedAt;

    // A SECOND qualify event is a no-op: the store's `qualified_at IS NULL`
    // predicate is the guard, so no reward journey re-fires.
    await ingestEvent({
      db,
      registry: container.registry,
      hatchet: container.hatchet,
      logger: container.logger,
      event: {
        event: "subscription.started",
        userId: `${RUN}-qual-referee`,
        eventProperties: { plan: "pro" },
        idempotencyKey: `${RUN}-qual-2`,
      },
    });
    await new Promise((r) => setTimeout(r, 300));
    const [after] = await touchesFor(referrer);
    expect(after?.qualifiedAt?.getTime()).toBe(firstQualifiedAt?.getTime());

    const busRows = await busEvents(
      "referral.qualified",
      `${RUN}-qual-referee`,
    );
    expect(busRows).toHaveLength(1);
  });

  it("qualifies when the identifying event IS the qualify event", async () => {
    // The bind in resolveContactShared is AWAITED so the qualify hook in
    // the SAME ingest sees `bound`; a detached bind lost this race.
    const referrer = await makeContact("qual-race-owner");
    const link = await getReferralLink({
      referral: "invite",
      contactId: referrer,
      container,
    });
    linkIds.push(link.linkId);
    const anonId = `${RUN}-anon-race`;
    await arrive(await clickAndGetRef(link.trackedLinkId), anonId);
    await waitFor(async () => {
      const rows = await touchesFor(referrer);
      return rows.length > 0 ? rows : null;
    }, "the race touch");

    const { ingestEvent } = await import("@hogsend/engine");
    await ingestEvent({
      db,
      registry: container.registry,
      hatchet: container.hatchet,
      logger: container.logger,
      event: {
        event: "subscription.started",
        anonymousId: anonId,
        userId: `${RUN}-race-referee`,
        email: `${RUN}-race-referee@example.test`,
        eventProperties: { plan: "pro" },
        idempotencyKey: `${RUN}-race-1`,
      },
    });
    const [row] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.externalId, `${RUN}-race-referee`));
    if (row) contactIds.push(row.id);

    await waitFor(async () => {
      const [t] = await touchesFor(referrer);
      return t?.status === "qualified" ? t : null;
    }, "the same-ingest qualify");
  });
});

describe("convert", () => {
  it("announces up a 3-deep chain with the right levels", async () => {
    // grandparent → parent → child, each edge a bound touch.
    const grandparent = await makeContact("tree-gp");
    const parent = await makeContact("tree-parent");
    const child = await makeContact("tree-child");

    await db.insert(referralTouches).values([
      {
        referralId: "invite",
        referrerContactId: grandparent,
        refereeKey: `${RUN}-tree-parent`,
        refereeContactId: parent,
        source: "manual",
        status: "bound",
        boundAt: new Date(),
      },
      {
        referralId: "invite",
        referrerContactId: parent,
        refereeKey: `${RUN}-tree-child`,
        refereeContactId: child,
        source: "manual",
        status: "bound",
        boundAt: new Date(),
      },
    ]);

    const [eventRow] = await db
      .insert(userEvents)
      .values({
        userId: `${RUN}-tree-child`,
        event: "order.completed",
        properties: {},
        contactId: child,
      })
      .returning({ id: userEvents.id });
    if (!eventRow) throw new Error("event insert failed");

    const [conversion] = await db
      .insert(conversions)
      .values({
        definitionId: `${RUN}-purchase`,
        contactId: child,
        userKey: `${RUN}-tree-child`,
        eventId: eventRow.id,
        value: 100,
        currency: "GBP",
        occurredAt: new Date(),
      })
      .returning({ id: conversions.id });
    if (!conversion) throw new Error("conversion insert failed");
    conversionIds.push(conversion.id);

    await convertReferral({
      db,
      hatchet: container.hatchet,
      registry: container.registry,
      logger: container.logger,
      referrals: container.referrals,
      contactId: child,
      conversionId: conversion.id,
      value: 100,
      currency: "GBP",
      occurredAt: new Date(),
    });

    // Level 1 — the DIRECT referrer gets `referral.converted`.
    const direct = await waitFor(async () => {
      const rows = await busEvents("referral.converted", `${RUN}-tree-parent`);
      return rows.length > 0 ? rows : null;
    }, "referral.converted for the parent");
    const directProps = direct[0]?.properties as Record<string, unknown>;
    expect(directProps.level).toBe(1);
    expect(directProps.refereeContactId).toBe(child);
    expect(directProps.viaContactId).toBe(child);
    // The amount rides `conversionValue`, NOT `value`: a `value` on the bus
    // copy would fire the built-in wildcard `revenue` conversion for the
    // BENEFICIARY and re-enter the tree walk from them.
    expect(directProps.conversionValue).toBe(100);
    expect(directProps.value).toBeUndefined();

    // Level 2 — the ancestor gets `referral.tree_converted`, with the NEXT hop
    // toward the referee so a journey can name "your friend's friend".
    const ancestor = await waitFor(async () => {
      const rows = await busEvents("referral.tree_converted", `${RUN}-tree-gp`);
      return rows.length > 0 ? rows : null;
    }, "referral.tree_converted for the grandparent");
    const ancestorProps = ancestor[0]?.properties as Record<string, unknown>;
    expect(ancestorProps.level).toBe(2);
    expect(ancestorProps.refereeContactId).toBe(child);
    expect(ancestorProps.viaContactId).toBe(parent);

    // The converting contact is told nothing: they are the referee, not a
    // beneficiary.
    expect(
      await busEvents("referral.converted", `${RUN}-tree-child`),
    ).toHaveLength(0);

    // No PHANTOM conversion: the announcement is news, not money. A `value` on
    // the bus copy would have minted a `revenue` conversion for every ancestor
    // and walked the tree again from each of them.
    await new Promise((r) => setTimeout(r, 300));
    const phantom = await db
      .select({ id: conversions.id })
      .from(conversions)
      .where(inArray(conversions.contactId, [parent, grandparent]));
    expect(phantom).toHaveLength(0);
    // Exactly ONE converted event per beneficiary, at its own level.
    expect(
      await busEvents("referral.converted", `${RUN}-tree-parent`),
    ).toHaveLength(1);
    expect(
      await busEvents("referral.converted", `${RUN}-tree-gp`),
    ).toHaveLength(0);
    expect(
      await busEvents("referral.tree_converted", `${RUN}-tree-gp`),
    ).toHaveLength(1);
  });
});
