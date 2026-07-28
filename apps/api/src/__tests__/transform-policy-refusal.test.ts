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
const { createHogsendClient, hatchet, ingestTransformResult } = await import(
  "@hogsend/engine"
);
type ResolvePolicy = import("@hogsend/engine").ResolvePolicy;

// Every identity value below is RUN-namespaced (A4): this file's assertions
// are row COUNTS, and an un-namespaced key on a reused database would let a
// stale contact row satisfy (or poison) them.
const RUN = `xfpol-${randomUUID()}`;
const uid = (label: string) => `${RUN}-${label}`;

const container = createHogsendClient();
const { db, registry, logger } = container;

const SERVER_TRUST: readonly ResolvePolicy["trustedKinds"][number][] = [
  "external",
  "email",
  "anonymous",
  "discord",
];

/** Live-or-dead contact rows owning `key` under EITHER identity column. */
async function contactsForKey(key: string) {
  return db
    .select({ id: contacts.id })
    .from(contacts)
    .where(or(eq(contacts.externalId, key), eq(contacts.anonymousId, key)));
}

/** Every contact row minted under this run's namespace, on either column. */
async function contactsForRun() {
  return db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      or(
        like(contacts.externalId, `${RUN}-%`),
        like(contacts.anonymousId, `${RUN}-%`),
      ),
    );
}

async function eventsForKey(key: string) {
  return db
    .select({ id: userEvents.id, event: userEvents.event })
    .from(userEvents)
    .where(eq(userEvents.userId, key));
}

afterAll(async () => {
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.anonymousId, `${RUN}-%`));
});

// ===========================================================================
// PRD 06 T4, L5 row 28 — `ingestTransformResult`'s per-element forwarding
// must thread a declared policy's `create` leg, or a transform-sourced
// refusal is silently lost: a webhook-source-derived event that should refuse
// to mint would mint instead.
// ===========================================================================
describe("ingestTransformResult policy pass-through (row 28)", () => {
  it("a transform-sourced refusal survives the per-element forwarding", async () => {
    const a = uid("refuse-a");
    const b = uid("refuse-b");

    const r = await ingestTransformResult({
      result: [
        { event: `${RUN}.observed`, anonymousId: a, eventProperties: {} },
        { event: `${RUN}.observed`, anonymousId: b, eventProperties: {} },
      ],
      db,
      registry,
      hatchet,
      logger,
      source: "api",
      policy: {
        create: "refuse-on-miss",
        allowMerge: "any",
        trustedKinds: SERVER_TRUST,
      },
    });

    // The refusal loses NO observation: both elements ingested and stored
    // under their own canonical keys (D2).
    expect(r.ingested).toBe(2);
    expect(await eventsForKey(a)).toHaveLength(1);
    expect(await eventsForKey(b)).toHaveLength(1);

    // The load-bearing assertion, on row COUNTS (namespace-scoped): the
    // `create: "refuse-on-miss"` leg reached every element's resolve. If the
    // forwarding dropped the policy, `ingestEvent`'s default (create-on-miss)
    // would mint one contact per element and this reads 2, not 0.
    expect(await contactsForKey(a)).toHaveLength(0);
    expect(await contactsForKey(b)).toHaveLength(0);
    expect(await contactsForRun()).toHaveLength(0);
  });

  it("an on-miss policy still creates (the control: only the create leg differs)", async () => {
    const c = uid("create-c");

    const r = await ingestTransformResult({
      result: { event: `${RUN}.asserted`, anonymousId: c, eventProperties: {} },
      db,
      registry,
      hatchet,
      logger,
      source: "api",
      policy: {
        create: "on-miss",
        allowMerge: "any",
        trustedKinds: SERVER_TRUST,
      },
    });

    // Proves the refusal above came from the DECLARED policy reaching the
    // resolve — not from some unrelated failure that happened to mint nothing.
    expect(r.ingested).toBe(1);
    expect(await eventsForKey(c)).toHaveLength(1);
    expect(await contactsForKey(c)).toHaveLength(1);
  });

  it("rejects the mix of policy and legacy allowCreate BEFORE the loop", async () => {
    const d = uid("mix-d");

    // Both trust shapes at once is a caller bug and must fail LOUDLY. The
    // guard sits before the loop on purpose: `ingestEvent` throws the same
    // complaint per element, but this helper's per-element error isolation
    // would swallow that into a warn and return `{ ingested: 0 }`.
    await expect(
      ingestTransformResult({
        result: { event: `${RUN}.mixed`, anonymousId: d, eventProperties: {} },
        db,
        registry,
        hatchet,
        logger,
        source: "api",
        allowCreate: false,
        policy: {
          create: "refuse-on-miss",
          allowMerge: "any",
          trustedKinds: SERVER_TRUST,
        },
      }),
    ).rejects.toThrow(/either `policy` or the legacy `allowCreate`/);

    // Thrown before any element ingested: no event stored, nothing minted.
    expect(await eventsForKey(d)).toHaveLength(0);
    expect(await contactsForKey(d)).toHaveLength(0);
  });
});
