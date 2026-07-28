/**
 * PRD 04 T4a — `user_events.contact_id` dual-write.
 *
 * The resolve `ingestEvent` already performs is threaded into BOTH insert
 * branches (idempotency-keyed and plain). Two load-bearing behaviours:
 *
 *   1. An identified subject stamps the owning `contacts.id`.
 *   2. A REFUSED resolve (`create: "refuse-on-miss"`) stamps NULL — by design,
 *      not by accident. The observation is still stored under the same
 *      canonical key and still mints nothing.
 *
 * Assertions read ROWS BACK from Postgres; the ingest return value proves
 * nothing about what landed in the column.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

// DB-touching test. The DEFAULT below is the repo-wide one every file in this
// directory shares, and it is what CI's service container listens on. Point a
// worktree at its own stack by exporting HOGSEND_TEST_DATABASE_URL — never by
// editing the default.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Mock Hatchet so `ingestEvent`'s push leg never needs a live engine.
const { hatchetMock } = vi.hoisted(() => {
  const push = vi.fn();
  const factory = () => ({
    hatchet: {
      durableTask: vi.fn((config: Record<string, unknown>) => ({
        ...config,
        run: vi.fn(),
        runNoWait: vi.fn(),
        runAndWait: vi.fn(),
      })),
      task: vi.fn((config: Record<string, unknown>) => ({
        ...config,
        run: vi.fn(),
        runNoWait: vi.fn(),
      })),
      events: { push },
      runs: { cancel: vi.fn(), get: vi.fn() },
      worker: vi.fn(),
    },
  });
  return { hatchetMock: factory };
});

vi.mock("../../../../packages/engine/src/lib/hatchet.ts", () => hatchetMock());
vi.mock("../lib/hatchet.js", () => hatchetMock());

const { contacts, userEvents } = await import("@hogsend/db");
const { eq, like, or } = await import("drizzle-orm");
const { createHogsendClient, hatchet, ingestEvent, resolveOrCreateContact } =
  await import("@hogsend/engine");
type ResolvePolicy = import("@hogsend/engine").ResolvePolicy;

const container = createHogsendClient();
const { db, registry, logger } = container;

// Every identity value below is RUN-namespaced: a shared database must never
// let a stale row satisfy (or poison) a count-shaped assertion.
const RUN = `ciev-${randomUUID()}`;
const uid = (label: string) => `${RUN}-${label}`;

const SERVER_TRUST: readonly ResolvePolicy["trustedKinds"][number][] = [
  "external",
  "email",
  "anonymous",
  "discord",
];

/** Every `user_events` row stored under one canonical key. */
async function eventsForKey(key: string) {
  return db
    .select({
      id: userEvents.id,
      event: userEvents.event,
      contactId: userEvents.contactId,
    })
    .from(userEvents)
    .where(eq(userEvents.userId, key));
}

/** Live-or-dead contact rows owning `key` under either identity column. */
async function contactsForKey(key: string) {
  return db
    .select({ id: contacts.id })
    .from(contacts)
    .where(or(eq(contacts.externalId, key), eq(contacts.anonymousId, key)));
}

afterAll(async () => {
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  await db
    .delete(contacts)
    .where(
      or(
        like(contacts.externalId, `${RUN}-%`),
        like(contacts.anonymousId, `${RUN}-%`),
        like(contacts.email, `${RUN}-%`),
      ),
    );
  await container.dbClient.end({ timeout: 5 }).catch(() => {});
});

describe("T4a — user_events.contact_id is stamped at ingest", () => {
  it("an identified subject's event carries the owning contacts.id", async () => {
    const ext = uid("identified");
    const contact = await resolveOrCreateContact({ db, userId: ext });

    const result = await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      event: {
        event: `${RUN}.viewed`,
        userId: ext,
        userEmail: "",
        eventProperties: { a: 1 },
      },
    });
    expect(result.stored).toBe(true);

    const rows = await eventsForKey(ext);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBe(contact.id);
  });

  it("the idempotency-keyed insert branch stamps it too", async () => {
    // The two `user_events` inserts are separate `.values()` calls; a fix
    // applied to only one of them turns exactly this test red.
    const ext = uid("idem");
    const contact = await resolveOrCreateContact({ db, userId: ext });

    await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      event: {
        event: `${RUN}.idem`,
        userId: ext,
        userEmail: "",
        eventProperties: {},
        idempotencyKey: `${RUN}:idem:1`,
      },
    });

    const rows = await eventsForKey(ext);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBe(contact.id);
  });

  it("a REFUSED anonymous ingest stores the event with NULL and mints nothing", async () => {
    const anon = uid("refused-anon");

    const result = await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      event: {
        event: `${RUN}.observed`,
        anonymousId: anon,
        userEmail: "",
        eventProperties: {},
      },
      policy: {
        create: "refuse-on-miss",
        allowMerge: "any",
        trustedKinds: SERVER_TRUST,
      },
    });

    // The refusal loses NO observation.
    expect(result.stored).toBe(true);
    const rows = await eventsForKey(anon);
    expect(rows).toHaveLength(1);
    // The specified behaviour: no contact row exists, so there is nothing
    // honest to stamp.
    expect(rows[0]?.contactId).toBeNull();
    expect(await contactsForKey(anon)).toHaveLength(0);
  });

  it("the control: the SAME event with create-on-miss stamps the minted row", async () => {
    // Proves the NULL above came from the refusal, not from the dual-write
    // being wired to nothing at all.
    const anon = uid("created-anon");

    await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      event: {
        event: `${RUN}.observed`,
        anonymousId: anon,
        userEmail: "",
        eventProperties: {},
      },
    });

    const minted = await contactsForKey(anon);
    expect(minted).toHaveLength(1);
    const rows = await eventsForKey(anon);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBe(minted[0]?.id);
  });
});
