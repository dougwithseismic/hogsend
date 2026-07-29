/**
 * PRD 05 T1/T1b — the read-side foundations.
 *
 *   • `bySubject(table, subject)` — the either/or history scope: `contact_id`
 *     when a contact is known, the mutable `user_id` text key otherwise.
 *   • The four contact relations now join `contact_id → contacts.id` instead of
 *     `user_id → contacts.external_id`.
 *   • `ConditionContext.contactId` reaching the `event` and `email_engagement`
 *     evaluator arms.
 *
 * Every predicate is EXECUTED against Postgres — asserting on generated SQL
 * would pass against a predicate that finds the wrong rows.
 *
 * Fixture law: no row here is ever "owned-but-NULL" (a `user_id` resolving to a
 * live contact while `contact_id` is NULL). Another file in this suite runs a
 * global backfill sweep that stamps exactly those rows mid-run. Contact-owned
 * fixtures carry `contact_id`; the rest use keys no contact claims.
 */
import { randomUUID } from "node:crypto";
// Imported from `@hogsend/core` (the canonical origin) rather than
// `@hogsend/engine`: the engine index carries a Hatchet runtime side effect
// this suite has no reason to load. The engine's re-export of `bySubject` is
// compiler-verified — a missing core export breaks `check-types`.
import { bySubject, evaluateCondition } from "@hogsend/core";
import { contacts, createDatabase, emailSends, userEvents } from "@hogsend/db";
import { and, eq, like, or, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// DB-touching test. The DEFAULT below is the repo-wide one every file in this
// directory shares, and it is what CI's service container listens on. Point a
// worktree at its own stack by exporting HOGSEND_TEST_DATABASE_URL — never by
// editing the default.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Run-namespaced identity values: the suite shares one database and runs twice
// against a reused one, so a stale row must never satisfy a count assertion.
const RUN = `t1bs-${randomUUID()}`;
const EXT_KEY = `${RUN}-x-ext`;
const ANON_KEY = `${RUN}-x-anon`;
const DETACHED_KEY = `${RUN}-detached`;
const GHOST_KEY = `${RUN}-ghost`;
const EV_SCOPED = `${RUN}.scoped`;
const EV_GHOST = `${RUN}.ghost`;
const EV_PURCHASE = `${RUN}.purchase`;
const EV_REL = `${RUN}.relation`;
const TPL_ADDRESS = `${RUN}-tpl-address`;
const TPL_CONTACT = `${RUN}-tpl-contact`;
const ADDRESS = `${RUN}-addr@example.com`;

const created = createDatabase({ url: process.env.DATABASE_URL as string });
const db = created.db;

let contactX: string;
let relationRowId: string;

beforeAll(async () => {
  const [x] = await db
    .insert(contacts)
    .values({
      externalId: EXT_KEY,
      anonymousId: ANON_KEY,
      email: `${RUN}-x@example.com`,
    })
    .returning({ id: contacts.id });
  contactX = x?.id as string;

  await db.insert(userEvents).values([
    // (1) Owned by X but stored under a string key X does NOT claim — the whole
    // point of the contactId arm.
    { userId: DETACHED_KEY, contactId: contactX, event: EV_SCOPED },
    { userId: DETACHED_KEY, contactId: contactX, event: EV_SCOPED },
    // (2) Contactless: GHOST_KEY resolves to no contact, so a backfill sweep
    // has nothing to stamp and this row stays NULL for the whole run.
    { userId: GHOST_KEY, contactId: null, event: EV_GHOST },
    // (4) Three purchases for X: two under a detached key, one under X's own
    // canonical key. contactId sees 3, the text key sees 1.
    { userId: DETACHED_KEY, contactId: contactX, event: EV_PURCHASE },
    { userId: DETACHED_KEY, contactId: contactX, event: EV_PURCHASE },
    { userId: EXT_KEY, contactId: contactX, event: EV_PURCHASE },
  ]);

  // (3) Relation fixture: keyed on X's ANONYMOUS id, which is deliberately not
  // its external_id — the old `user_id → contacts.external_id` join cannot
  // resolve it.
  const [rel] = await db
    .insert(userEvents)
    .values({ userId: ANON_KEY, contactId: contactX, event: EV_REL })
    .returning({ id: userEvents.id });
  relationRowId = rel?.id as string;

  await db.insert(emailSends).values([
    // (5a) Address-keyed, no owning contact: the contactless fallback path.
    {
      templateKey: TPL_ADDRESS,
      fromEmail: "from@hogsend.com",
      toEmail: ADDRESS,
      subject: "address arm",
      status: "opened",
      openedAt: new Date(),
    },
    // (5b) Owned by X at an address the caller does NOT know about.
    {
      templateKey: TPL_CONTACT,
      fromEmail: "from@hogsend.com",
      toEmail: `${RUN}-different@example.com`,
      contactId: contactX,
      subject: "contact arm",
      status: "opened",
      openedAt: new Date(),
    },
  ]);
});

afterAll(async () => {
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  await db
    .delete(emailSends)
    .where(like(emailSends.templateKey, `${RUN}-tpl-%`));
  await db
    .delete(contacts)
    .where(
      or(
        like(contacts.externalId, `${RUN}-%`),
        like(contacts.anonymousId, `${RUN}-%`),
        like(contacts.email, `${RUN}-%`),
      ),
    );
  await created.client.end({ timeout: 5 });
});

/** Count `user_events` rows matching a scope, narrowed to one fixture event. */
async function countEvents(scope: ReturnType<typeof bySubject>, event: string) {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(userEvents)
    .where(and(scope, eq(userEvents.event, event)));
  return Number(row?.count ?? 0);
}

describe("bySubject — either/or history scope", () => {
  it("the contactId arm ignores the userKey entirely", async () => {
    const found = await countEvents(
      bySubject(userEvents, {
        contactId: contactX,
        // A key NOTHING in the fixture set was written under: if this leaked
        // into the predicate as an OR arm the count would still be 2, so the
        // control below is what actually proves the either/or.
        userKey: `${RUN}-not-a-key`,
      }),
      EV_SCOPED,
    );
    expect(found).toBe(2);
  });

  it("without a contactId the same rows are unreachable by their string key", async () => {
    // Proves the arm above scoped by contact_id rather than by accident.
    const found = await countEvents(
      bySubject(userEvents, {
        contactId: null,
        userKey: `${RUN}-not-a-key`,
      }),
      EV_SCOPED,
    );
    expect(found).toBe(0);
  });

  it("the null arm falls back to the user_id text key", async () => {
    const found = await countEvents(
      bySubject(userEvents, { contactId: null, userKey: GHOST_KEY }),
      EV_GHOST,
    );
    expect(found).toBe(1);
  });

  it("the null arm finds nothing under a different key", async () => {
    const found = await countEvents(
      bySubject(userEvents, { contactId: null, userKey: `${RUN}-other` }),
      EV_GHOST,
    );
    expect(found).toBe(0);
  });

  it("treats undefined like null", async () => {
    const found = await countEvents(
      bySubject(userEvents, { contactId: undefined, userKey: GHOST_KEY }),
      EV_GHOST,
    );
    expect(found).toBe(1);
  });
});

describe("contact relations join contact_id → contacts.id", () => {
  it("resolves a row keyed on the contact's anonymous id", async () => {
    // RED before the relations flip: the old join is
    // `user_events.user_id → contacts.external_id`, and this row's user_id is
    // X's ANONYMOUS id, so `contact` comes back undefined.
    const row = await db.query.userEvents.findFirst({
      where: eq(userEvents.id, relationRowId),
      with: { contact: true },
    });

    expect(row?.userId).toBe(ANON_KEY);
    expect(row?.contact?.id).toBe(contactX);
    expect(row?.contact?.externalId).toBe(EXT_KEY);
  });
});

describe("ConditionContext.contactId reaches the evaluator arms", () => {
  const purchases = (check: "count", value: number) =>
    ({
      type: "event",
      eventName: EV_PURCHASE,
      check,
      operator: "eq",
      value,
    }) as const;

  it("an event condition with a contactId counts rows under other keys", async () => {
    const ctx = {
      db,
      userId: EXT_KEY,
      contactId: contactX,
      journeyContext: {},
    };
    await expect(
      evaluateCondition({ condition: purchases("count", 3), ctx }),
    ).resolves.toBe(true);
    await expect(
      evaluateCondition({ condition: purchases("count", 1), ctx }),
    ).resolves.toBe(false);
  });

  it("the same condition with a null contactId counts only the text key", async () => {
    const ctx = { db, userId: EXT_KEY, contactId: null, journeyContext: {} };
    await expect(
      evaluateCondition({ condition: purchases("count", 1), ctx }),
    ).resolves.toBe(true);
    await expect(
      evaluateCondition({ condition: purchases("count", 3), ctx }),
    ).resolves.toBe(false);
  });
});

describe("email_engagement keeps its address-keyed fallback", () => {
  it("resolves by to_email when contactId is null", async () => {
    await expect(
      evaluateCondition({
        condition: {
          type: "email_engagement",
          templateKey: TPL_ADDRESS,
          check: "opened",
        },
        ctx: {
          db,
          userId: `${RUN}-irrelevant`,
          contactId: null,
          email: ADDRESS,
          journeyContext: {},
        },
      }),
    ).resolves.toBe(true);
  });

  it("finds nothing at a different address when contactId is null", async () => {
    await expect(
      evaluateCondition({
        condition: {
          type: "email_engagement",
          templateKey: TPL_ADDRESS,
          check: "opened",
        },
        ctx: {
          db,
          userId: `${RUN}-irrelevant`,
          contactId: null,
          email: `${RUN}-wrong@example.com`,
          journeyContext: {},
        },
      }),
    ).resolves.toBe(false);
  });

  it("a set contactId supersedes the address", async () => {
    // The send lives at an address `ctx.email` does not name; only the
    // contact_id leg can reach it.
    await expect(
      evaluateCondition({
        condition: {
          type: "email_engagement",
          templateKey: TPL_CONTACT,
          check: "opened",
        },
        ctx: {
          db,
          userId: EXT_KEY,
          contactId: contactX,
          email: ADDRESS,
          journeyContext: {},
        },
      }),
    ).resolves.toBe(true);
  });

  it("the contact arm does not see a send that is not the contact's", async () => {
    // TPL_ADDRESS was sent to ADDRESS with no owning contact. With X's
    // contactId set, the address is no longer consulted at all.
    await expect(
      evaluateCondition({
        condition: {
          type: "email_engagement",
          templateKey: TPL_ADDRESS,
          check: "opened",
        },
        ctx: {
          db,
          userId: EXT_KEY,
          contactId: contactX,
          email: ADDRESS,
          journeyContext: {},
        },
      }),
    ).resolves.toBe(false);
  });
});
