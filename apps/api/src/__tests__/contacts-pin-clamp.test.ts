import type { ResolvePolicy } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

// Same real test DB the engine singletons + the route container read.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Hatchet via the override seam — nothing here pushes, but the container needs
// a handle and a live engine must never be reached from a unit suite.
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
} as unknown as ReturnType<typeof createHogsendClient>["hatchet"];

const { contactAliases, contacts } = await import("@hogsend/db");
const { eq, inArray } = await import("drizzle-orm");
const { createHogsendClient, resolveOrCreateContact } = await import(
  "@hogsend/engine"
);

const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const { db } = container;

// PRD 06 T1 mutation-gate gap-filler: no existing test dies when the
// `!clamped` read is dropped from the provenance pin gate
// (`contacts.ts` — `if (contactId && UUID_REGEX.test(contactId) && !clamped)`).
// The pin is unreachable from any browser ROUTE today (the public Zod schemas
// strip `contactId`), so this file exercises the resolver entry point
// directly — exactly where a future engine-internal caller would get it wrong
// by threading a subject pin into a clamped publishable write. The invariant
// under test: a clamped anon-only write must NEVER short-circuit to (or
// mutate) the pinned row; the pin is IGNORED and value resolution runs.
//
// Every identity value is run-namespaced and every row assertion is scoped to
// this run's namespace — a fixed literal here would pass exactly once per
// database and be red forever after (the buckets.test.ts defect).
const RUN = `pinclamp-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

const createdIds: string[] = [];

async function readById(id: string) {
  const rows = await db
    .select()
    .from(contacts)
    .where(eq(contacts.id, id))
    .limit(1);
  return rows[0];
}

function propsOf(row: { properties: unknown } | undefined) {
  return (row?.properties ?? {}) as Record<string, unknown>;
}

/** An IDENTIFIED contact — the pin target a clamped write must never touch. */
async function newVictim(tag: string, plan: string) {
  const victim = await resolveOrCreateContact({
    db,
    userId: `${RUN}-victim-${tag}`,
    contactProperties: { plan },
  });
  createdIds.push(victim.id);
  expect(victim.created).toBe(true);
  return victim;
}

afterAll(async () => {
  if (createdIds.length === 0) return;
  await db
    .delete(contactAliases)
    .where(inArray(contactAliases.contactId, createdIds));
  await db.delete(contacts).where(inArray(contacts.id, createdIds));
});

describe("provenance pin × publishable clamp — the pin is ignored on a clamped write", () => {
  it("legacy shape: restrictToAnonymous + contactId → pin ignored, pinned row untouched, anon's own contact minted", async () => {
    const victim = await newVictim("legacy", "enterprise");
    const anon = `${RUN}-anon-legacy`;

    const r = await resolveOrCreateContact({
      db,
      anonymousId: anon,
      // A forged/mistaken engine-internal pin arriving alongside a clamped
      // publishable write. The clamp must win: no short-circuit to this row.
      contactId: victim.id,
      restrictToAnonymous: true,
      contactProperties: { probe: "legacy-clamped-write" },
    });
    createdIds.push(r.id);

    // Pin IGNORED: value resolution ran, missed, and minted the anon
    // visitor's OWN contact — never the pinned row.
    expect(r.id).not.toBe(victim.id);
    expect(r.created).toBe(true);
    expect(r.resolvedKey).toBe(anon);

    // Observable state, not just the return value: the pinned contact's
    // properties are unmutated; the patch landed on the new anon row only.
    const pinnedRow = await readById(victim.id);
    expect(propsOf(pinnedRow).probe).toBeUndefined();
    expect(propsOf(pinnedRow).plan).toBe("enterprise");

    const anonRow = await readById(r.id);
    expect(anonRow?.anonymousId).toBe(anon);
    expect(anonRow?.externalId).toBeNull();
    expect(propsOf(anonRow).probe).toBe("legacy-clamped-write");

    // Namespace-scoped row count: exactly ONE contact owns this anon id.
    const owners = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.anonymousId, anon));
    expect(owners).toHaveLength(1);
  });

  it("policy shape: allowMerge 'anonymous-only' + contactId → the same clamp, the same ignored pin (T1 equivalence)", async () => {
    const victim = await newVictim("policy", "scale");
    const anon = `${RUN}-anon-policy`;

    const policy: ResolvePolicy = {
      create: "on-miss",
      allowMerge: "anonymous-only",
      trustedKinds: ["anonymous"],
    };
    const r = await resolveOrCreateContact({
      db,
      anonymousId: anon,
      contactId: victim.id,
      policy,
      contactProperties: { probe: "policy-clamped-write" },
    });
    createdIds.push(r.id);

    expect(r.id).not.toBe(victim.id);
    expect(r.created).toBe(true);
    expect(r.resolvedKey).toBe(anon);

    const pinnedRow = await readById(victim.id);
    expect(propsOf(pinnedRow).probe).toBeUndefined();
    expect(propsOf(pinnedRow).plan).toBe("scale");

    const anonRow = await readById(r.id);
    expect(anonRow?.anonymousId).toBe(anon);
    expect(anonRow?.externalId).toBeNull();
    expect(propsOf(anonRow).probe).toBe("policy-clamped-write");

    const owners = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.anonymousId, anon));
    expect(owners).toHaveLength(1);
  });

  it("control: WITHOUT the clamp the pin short-circuits to the pinned row — proving the clamped assertions above bite", async () => {
    const victim = await newVictim("control", "starter");
    const anon = `${RUN}-anon-control`;

    const r = await resolveOrCreateContact({
      db,
      anonymousId: anon,
      contactId: victim.id,
      contactProperties: { probe: "unclamped-pin-write" },
    });

    // The unclamped pin resolves the pinned row and merge-folds the patch.
    expect(r.id).toBe(victim.id);
    expect(r.created).toBe(false);

    const pinnedRow = await readById(victim.id);
    expect(propsOf(pinnedRow).probe).toBe("unclamped-pin-write");
    expect(propsOf(pinnedRow).plan).toBe("starter"); // merge, not replace

    // No contact was minted for the anon value (namespace-scoped).
    const owners = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.anonymousId, anon));
    expect(owners).toHaveLength(0);
  });
});
