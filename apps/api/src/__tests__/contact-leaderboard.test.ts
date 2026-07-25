/**
 * PRD 06 — contact leaderboard: rank `GET /v1/admin/contacts` by the NUMERIC
 * value of a jsonb property, plus a `propertyKey`/`propertyGte` numeric filter.
 *
 * The defect class under test throughout: `contacts.properties` is untyped
 * jsonb and `/v1/events` accepts arbitrary values, so a bare
 * `(properties->>key)::numeric` raises Postgres 22P02 the first time ONE
 * contact holds a string at the key. Every ordering/filtering expression must
 * therefore be guarded with `jsonb_typeof(...) = 'number'` — AC 4, 8 and 9
 * seed a STRING at the key before asserting, or they would prove nothing.
 */
import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

// DB-touching test. The DEFAULT below is the repo-wide one every file in this
// directory shares, and it is what CI's service container listens on
// (.github/workflows/ci.yml). Point a worktree at its own stack by exporting
// HOGSEND_TEST_DATABASE_URL — never by editing the default, which is how this
// file once ended up green locally and broken in CI.
// Needs schema at migration 0067 (`contacts_properties_gin_idx`).
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";
console.log(
  `[contact-leaderboard] resolved DATABASE_URL = ${process.env.DATABASE_URL}`,
);

const { contacts, userEvents } = await import("@hogsend/db");
const { eq, like, sql } = await import("drizzle-orm");
const { createApp, createHogsendClient } = await import("@hogsend/engine");

// Hatchet injected via the container override seam: AC 9 drives the normal
// ingest path (`POST /v1/events`), whose pipeline pushes to Hatchet.
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

const AUTH_HEADER = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
  "Content-Type": "application/json",
};

// Run-scoped ids so parallel suites against the shared docker DB never
// collide; `search=RUN` isolates the list to this file's fixtures (which also
// regression-proves the new ordering params COMPOSE with the existing search
// filter). Everything created here is swept in afterAll.
const RUN = `clb-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const uid = (label: string) => `${RUN}-${label}`;

const DAY = 86_400_000;
const NOW = Date.now();
const seen = (daysAgo: number) => new Date(NOW - daysAgo * DAY);

// Fixture set — scores DELIBERATELY anti-correlated with recency so a sort
// that silently fell back to lastSeenAt cannot pass the property-order
// assertions. `delta` holds a STRING at the sort key (the 22P02 trigger);
// `echo` has no score at all.
const FIXTURES = [
  { label: "alpha", props: { gtmScore: 90 }, daysAgo: 5 },
  { label: "bravo", props: { gtmScore: 20 }, daysAgo: 4 },
  { label: "charlie", props: { gtmScore: 5 }, daysAgo: 3 },
  { label: "delta", props: { gtmScore: "n/a" }, daysAgo: 2 },
  { label: "echo", props: {}, daysAgo: 1 },
] as const;

await db.insert(contacts).values(
  FIXTURES.map((f) => ({
    externalId: uid(f.label),
    email: `${uid(f.label)}@leaderboard.test`,
    properties: f.props as Record<string, unknown>,
    firstSeenAt: seen(f.daysAgo),
    lastSeenAt: seen(f.daysAgo),
  })),
);

async function list(params: Record<string, string>): Promise<Response> {
  const qs = new URLSearchParams({ search: RUN, ...params });
  return app.request(`/v1/admin/contacts?${qs}`, { headers: AUTH_HEADER });
}

async function listedIds(params: Record<string, string>): Promise<string[]> {
  const res = await list(params);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    contacts: { externalId: string | null }[];
  };
  return body.contacts.map((c) => c.externalId ?? "");
}

afterAll(async () => {
  await db.execute(sql`DROP INDEX IF EXISTS contacts_gtm_score_idx`);
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}-%`));
});

it("harness: honours HOGSEND_TEST_DATABASE_URL, and falls back to the repo default", () => {
  // The invariant is the OVERRIDE, not any particular port. An earlier version
  // of this test asserted `:5438/` — this worktree's port — which passed
  // locally and failed in CI, where Postgres is on 5434 (.github/workflows/ci.yml).
  // Pinning a port here re-creates the exact defect PRD 10 removed, just
  // inverted: instead of forcing everyone onto one machine's database, it
  // forces everyone onto one machine's port number.
  const override = process.env.HOGSEND_TEST_DATABASE_URL;
  if (override) {
    expect(process.env.DATABASE_URL).toBe(override);
  } else {
    // The repo default, shared by every file in this directory and matched by
    // the CI service container.
    expect(process.env.DATABASE_URL).toContain(":5434/");
  }
});

describe("ordering (AC 1, 4, 6)", () => {
  it("AC 1: orderBy=property&orderDir=desc ranks by numeric value, highest first, unscored last", async () => {
    const ids = await listedIds({
      orderBy: "property",
      orderProperty: "gtmScore",
      orderDir: "desc",
    });
    // 90, 20, 5, then the NULL bucket (echo before delta — the lastSeenAt
    // tiebreak inside NULLS LAST is deterministic).
    expect(ids).toEqual([
      uid("alpha"),
      uid("bravo"),
      uid("charlie"),
      uid("echo"),
      uid("delta"),
    ]);
  });

  it("AC 4: a contact holding a STRING at the ordering key sorts as null instead of erroring, in BOTH directions", async () => {
    // `delta` holds "n/a" at gtmScore — a bare ::numeric cast makes this
    // request 500 with Postgres 22P02. The guarded CASE returns 200 and
    // sorts delta into the NULL bucket. NULLS LAST holds in BOTH directions.
    const asc = await listedIds({
      orderBy: "property",
      orderProperty: "gtmScore",
      orderDir: "asc",
    });
    expect(asc).toEqual([
      uid("charlie"),
      uid("bravo"),
      uid("alpha"),
      uid("echo"),
      uid("delta"),
    ]);
  });

  it("orderBy=firstSeenAt&orderDir=asc orders oldest first (query-surface completeness)", async () => {
    const ids = await listedIds({ orderBy: "firstSeenAt", orderDir: "asc" });
    expect(ids).toEqual([
      uid("alpha"),
      uid("bravo"),
      uid("charlie"),
      uid("delta"),
      uid("echo"),
    ]);
  });

  it("AC 6 (regression): NO ordering params behaves exactly as before — ORDER BY lastSeenAt DESC", async () => {
    // The fixtures' recency order is the REVERSE of their score order, so a
    // default that accidentally routed through the property sort cannot pass.
    const ids = await listedIds({});
    expect(ids).toEqual([
      uid("echo"),
      uid("delta"),
      uid("charlie"),
      uid("bravo"),
      uid("alpha"),
    ]);
  });
});

describe("validation (AC 2, 3, 7)", () => {
  it("AC 2: orderBy=property without orderProperty responds 400", async () => {
    const res = await list({ orderBy: "property" });
    expect(res.status).toBe(400);
  });

  it("AC 3: a key with a character outside [A-Za-z0-9_.-] responds 400 (both params)", async () => {
    const cases: Record<string, string>[] = [
      { orderBy: "property", orderProperty: "gtm score" },
      { propertyKey: "gtm score", propertyGte: "1" },
    ];
    for (const params of cases) {
      const res = await list(params);
      expect(res.status).toBe(400);
    }
  });

  it("AC 3: a key exceeding 64 characters responds 400", async () => {
    const long = "k".repeat(65);
    const res = await list({ orderBy: "property", orderProperty: long });
    expect(res.status).toBe(400);
  });

  it("AC 7: a key containing SQL metacharacters is rejected at validation", async () => {
    const hostile = "gtmScore'); DROP TABLE contacts;--";
    const cases: Record<string, string>[] = [
      { orderBy: "property", orderProperty: hostile },
      { propertyKey: hostile, propertyGte: "1" },
    ];
    for (const params of cases) {
      const res = await list(params);
      expect(res.status).toBe(400);
    }
  });

  it("AC 7: the underlying expression passes the key as a BOUND PARAMETER — a hostile key is inert even past validation", async () => {
    // Validation is layer one; this proves layer two independently by running
    // the exact guarded expression the route builds, with a hostile key bound
    // as a parameter. Bound, it is a literal jsonb key that matches nothing;
    // interpolated, it would be a SQL injection.
    const hostile = "x'); DROP TABLE contacts; --";
    const result = (await db.execute(
      sql`select count(*)::int as n from ${contacts}
          where CASE WHEN jsonb_typeof(${contacts.properties} -> ${hostile}) = 'number'
                     THEN (${contacts.properties} ->> ${hostile})::numeric END >= 0`,
    )) as unknown as { n: number }[];
    expect(result[0]?.n).toBe(0);
    // The contacts table survived — the payload was data, not SQL.
    const alive = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.externalId, uid("alpha")));
    expect(alive).toHaveLength(1);
  });

  it("propertyGte without propertyKey responds 400 (dangling filter half)", async () => {
    const res = await list({ propertyGte: "20" });
    expect(res.status).toBe(400);
  });
});

describe("numeric filter (AC 5, 8)", () => {
  it("AC 5: propertyKey=gtmScore&propertyGte=20 returns only contacts with a numeric value ≥ 20", async () => {
    const ids = await listedIds({ propertyKey: "gtmScore", propertyGte: "20" });
    // Default ordering (lastSeenAt desc) still applies within the filter.
    expect(ids).toEqual([uid("bravo"), uid("alpha")]);
  });

  it("AC 8: a contact holding a STRING at propertyKey is EXCLUDED by the filter without erroring", async () => {
    // delta's "n/a" would 22P02 a bare cast; the guard turns it into NULL,
    // which fails the ≥ comparison — excluded, not erroring.
    const res = await list({ propertyKey: "gtmScore", propertyGte: "0" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      contacts: { externalId: string | null }[];
    };
    const ids = body.contacts.map((c) => c.externalId);
    expect(ids).toContain(uid("alpha"));
    expect(ids).toContain(uid("charlie"));
    expect(ids).not.toContain(uid("delta"));
    expect(ids).not.toContain(uid("echo"));
  });

  it("filter and property ordering COMPOSE", async () => {
    const ids = await listedIds({
      propertyKey: "gtmScore",
      propertyGte: "10",
      orderBy: "property",
      orderProperty: "gtmScore",
      orderDir: "asc",
    });
    expect(ids).toEqual([uid("bravo"), uid("alpha")]);
  });
});

describe("indexes (AC 9 + T6.1)", () => {
  it("T6.1: migration 0067 created the GIN index on contacts.properties", async () => {
    const result = (await db.execute(
      sql`select indexdef from pg_indexes
          where tablename = 'contacts'
            and indexname = 'contacts_properties_gin_idx'`,
    )) as unknown as { indexdef: string }[];
    expect(result).toHaveLength(1);
    expect(String(result[0]?.indexdef)).toContain("gin");
    expect(String(result[0]?.indexdef)).toContain("jsonb_path_ops");
  });

  it("AC 9: the documented GUARDED expression index tolerates a later non-numeric write via the normal ingest path", async () => {
    // The docs' verbatim per-key acceleration index. A BARE-CAST index here
    // would error during index maintenance on the write below — a write-path
    // outage. The guard makes index maintenance yield NULL instead.
    await db.execute(sql`
      CREATE INDEX contacts_gtm_score_idx
        ON contacts ((CASE WHEN jsonb_typeof(properties->'gtmScore') = 'number'
                           THEN (properties->>'gtmScore')::numeric END) DESC NULLS LAST)
    `);
    try {
      const userId = uid("foxtrot");
      const res = await app.request("/v1/events", {
        method: "POST",
        headers: AUTH_HEADER,
        body: JSON.stringify({
          name: "leaderboard.refined",
          userId,
          email: `${userId}@leaderboard.test`,
          contactProperties: { gtmScore: "n/a" },
        }),
      });
      // The ingest WRITE succeeded while the expression index stood.
      expect(res.status).toBe(202);
      const [row] = await db
        .select()
        .from(contacts)
        .where(eq(contacts.externalId, userId));
      expect(row?.properties?.gtmScore).toBe("n/a");
    } finally {
      await db.execute(sql`DROP INDEX IF EXISTS contacts_gtm_score_idx`);
    }
  });
});
