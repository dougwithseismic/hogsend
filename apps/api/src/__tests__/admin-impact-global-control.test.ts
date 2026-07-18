import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";
// GLOBAL_CONTROL_PERCENT / GLOBAL_CONTROL_SALT are read per-CALL by
// globalControlPercent()/isGlobalControl() (lib/holdout.ts), so tests set
// them per-test; unset at module load means the boot path sees "off".
delete process.env.GLOBAL_CONTROL_PERCENT;
delete process.env.GLOBAL_CONTROL_SALT;

const { contacts, conversions, userEvents } = await import("@hogsend/db");
const { like, sql } = await import("drizzle-orm");
const {
  computeGlobalControlReadout,
  createApp,
  createHogsendClient,
  isGlobalControl,
} = await import("@hogsend/engine");

const RUN = `gcimpact-${Date.now()}`;

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
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };
const SINCE = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

afterAll(async () => {
  delete process.env.GLOBAL_CONTROL_PERCENT;
  delete process.env.GLOBAL_CONTROL_SALT;
  // conversions cascade from contacts (contact_id FK, onDelete cascade)
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}%`));
});

const seedContacts = async (n: number) => {
  const rows = Array.from({ length: n }, (_, i) => ({
    externalId: `${RUN}-c${String(i).padStart(3, "0")}`,
    email: `${RUN}-c${i}@example.test`,
  }));
  return db
    .insert(contacts)
    .values(rows)
    .returning({ id: contacts.id, externalId: contacts.externalId });
};

const seedConversionFor = async (contactId: string, userKey: string) => {
  const [event] = await db
    .insert(userEvents)
    .values({ userId: userKey, event: `${RUN}.sold`, occurredAt: new Date() })
    .returning({ id: userEvents.id });
  if (!event) throw new Error("event insert failed");
  await db.insert(conversions).values({
    definitionId: `${RUN}-sale`,
    contactId,
    userKey,
    eventId: event.id,
    occurredAt: new Date(),
  });
};

/** Brute-force parity oracle: replicate the readout's enumeration with the
 * REAL isGlobalControl. This file runs in the serial vitest project (see
 * vitest.config.ts), so no other file mutates contacts mid-comparison. */
const bruteForce = async () => {
  const all = await db.execute<{
    id: string;
    external_id: string | null;
    anonymous_id: string | null;
  }>(sql`
    select id, external_id, anonymous_id
    from contacts where deleted_at is null
  `);
  const conv = await db.execute<{ contact_id: string }>(sql`
    select distinct contact_id from conversions
    where occurred_at >= ${SINCE.toISOString()}::timestamptz
  `);
  const converterSet = new Set([...conv].map((r) => r.contact_id));
  const treatment = { contacts: 0, converters: 0 };
  const control = { contacts: 0, converters: 0 };
  for (const row of [...all]) {
    const key = row.external_id ?? row.anonymous_id ?? row.id;
    const bucket = isGlobalControl(key) ? control : treatment;
    bucket.contacts += 1;
    if (converterSet.has(row.id)) bucket.converters += 1;
  }
  return { treatment, control };
};

describe("global control — off", () => {
  it("percent 0 → { state: 'off' } on the overview route", async () => {
    delete process.env.GLOBAL_CONTROL_PERCENT;
    const body = await (
      await app.request("/v1/admin/impact/overview", {
        headers: AUTH_HEADER,
      })
    ).json();
    expect(body.globalControl).toEqual({ state: "off" });
  });
});

describe("global control — computed", () => {
  it("JS tally equals the brute-force isGlobalControl scan (incl. converters), and pagination is invariant", async () => {
    const seeded = await seedContacts(60);
    for (const row of seeded.slice(0, 5)) {
      if (!row.externalId) throw new Error("seed missing externalId");
      await seedConversionFor(row.id, row.externalId);
    }
    process.env.GLOBAL_CONTROL_PERCENT = "10";
    process.env.GLOBAL_CONTROL_SALT = `${RUN}-salt-a`;

    const expected = await bruteForce();
    const readout = await computeGlobalControlReadout({ db, since: SINCE });
    expect(readout.state).toBe("computed");
    if (readout.state !== "computed") return;
    expect(readout.causal).toBe(true);
    expect(readout.percent).toBe(10);
    expect(readout.treatment.contacts).toBe(expected.treatment.contacts);
    expect(readout.treatment.converters).toBe(expected.treatment.converters);
    expect(readout.control.contacts).toBe(expected.control.contacts);
    expect(readout.control.converters).toBe(expected.control.converters);
    expect(readout.contactsScanned).toBe(
      expected.treatment.contacts + expected.control.contacts,
    );

    // keyset pagination: a batch smaller than the population must walk
    // multiple pages to the identical tally
    const paged = await computeGlobalControlReadout({
      db,
      since: SINCE,
      batchSize: 7,
    });
    expect(paged).toEqual(readout);
  });

  it("the overview route emits the computed state with verdict fields", async () => {
    process.env.GLOBAL_CONTROL_PERCENT = "10";
    process.env.GLOBAL_CONTROL_SALT = `${RUN}-salt-a`;
    const body = await (
      await app.request("/v1/admin/impact/overview", {
        headers: AUTH_HEADER,
      })
    ).json();
    const gc = body.globalControl;
    expect(gc.state).toBe("computed");
    expect(gc.causal).toBe(true);
    expect(gc.percent).toBe(10);
    expect(typeof gc.suppressed).toBe("boolean");
    expect(typeof gc.smallSample).toBe("boolean");
    expect(gc.treatment.contacts + gc.control.contacts).toBe(
      gc.contactsScanned,
    );
  });

  it("salt rotation re-buckets membership (golden fixed-key sets) and parity holds under the new salt", async () => {
    process.env.GLOBAL_CONTROL_PERCENT = "10";
    process.env.GLOBAL_CONTROL_SALT = `${RUN}-salt-b`;
    const expectedB = await bruteForce();
    const readoutB = await computeGlobalControlReadout({ db, since: SINCE });
    expect(readoutB.state).toBe("computed");
    if (readoutB.state !== "computed") return;
    expect(readoutB.control.contacts).toBe(expectedB.control.contacts);
    expect(readoutB.treatment.contacts).toBe(expectedB.treatment.contacts);

    // Deterministic golden membership: 10%, fixed salts, fixed keys —
    // verified values, safe from flake. Rotation MUST change the sets.
    const keys = Array.from({ length: 60 }, (_, i) => {
      return `gc-fixed-${String(i).padStart(3, "0")}`;
    });
    process.env.GLOBAL_CONTROL_SALT = "salt-a";
    const memberA = keys.filter((k) => isGlobalControl(k));
    process.env.GLOBAL_CONTROL_SALT = "salt-b";
    const memberB = keys.filter((k) => isGlobalControl(k));
    expect(memberA).toEqual([
      "gc-fixed-014",
      "gc-fixed-017",
      "gc-fixed-020",
      "gc-fixed-026",
      "gc-fixed-051",
      "gc-fixed-053",
      "gc-fixed-057",
    ]);
    expect(memberB).toEqual([
      "gc-fixed-016",
      "gc-fixed-019",
      "gc-fixed-026",
      "gc-fixed-052",
    ]);
  });
});

describe("global control — skipped ceiling", () => {
  it("population above the scan ceiling → skipped, visibly distinct from off", async () => {
    process.env.GLOBAL_CONTROL_PERCENT = "5";
    const readout = await computeGlobalControlReadout({
      db,
      since: SINCE,
      scanCeiling: 1,
    });
    expect(readout.state).toBe("skipped");
    if (readout.state !== "skipped") return;
    expect(readout.reason).toBe("too_many_contacts");
    expect(readout.percent).toBe(5);
    expect(readout.contactCount).toBeGreaterThan(1);
  });
});
