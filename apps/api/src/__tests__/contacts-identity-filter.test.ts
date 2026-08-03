/**
 * PRD 01 (identity model) — "anonymous-only contacts are a DISPLAY concern".
 * `GET /v1/admin/contacts` gains `identity=all|identified|anonymous`, backed by
 * the single exported predicate `identifiedContactFilter()`.
 *
 * The defect class under test: "identified" is a FOUR-column disjunction —
 * `external_id`, `email`, `discord_id`, `phone`. The schema documents
 * `discord_id` and `phone` as RESOLVABLE identity keys, NOT properties
 * (`packages/db/src/schema/contacts.ts:34-53`, each with its own live
 * partial-unique index). A Discord-linked member or an SMS-only subscriber HAS
 * identified; dropping either leg makes a real customer VANISH from Studio's
 * default list. So the fixture set below carries one contact identified by each
 * column ALONE — remove any single operand from the disjunction and the
 * "identified" assertions go red. (Mutation proof per
 * `reference_vacuous-green-tests`: a green suite under a removed operand means
 * the fixtures are wrong, not the predicate.)
 *
 * Count consistency is the other pinned invariant: the route feeds ONE `where`
 * to both the page query and the `count()`, so `total` must move with the rows.
 * A future edit that filters `rows` but not `count()` fails here, not in prod.
 */
import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

// DB-touching test. The DEFAULT below is the repo-wide one every file in this
// directory shares, and it is what CI's service container listens on
// (.github/workflows/ci.yml). Point a worktree at its own stack by exporting
// HOGSEND_TEST_DATABASE_URL — never by editing the default, which is how a
// sibling file once ended up green locally and broken in CI.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts } = await import("@hogsend/db");
const { inArray } = await import("drizzle-orm");
const { createApp, createHogsendClient } = await import("@hogsend/engine");

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

// Run-scoped isolation, but NOT via `search`: `contactSearchFilter` matches
// email / external_id / anonymous_id / discord_id and NOT phone, so a genuinely
// phone-ONLY fixture is unreachable through the search box. Isolating on a
// run-unique NUMERIC jsonb property instead lets every fixture carry exactly
// one identity column and nothing else — which is the whole point of the
// per-column mutation proof. It also exercises the composition requirement
// (`identity` AND `propertyKey`/`propertyGte` applied conjunctively).
const RUN = `cif_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const PHONE = `+1${String(Math.floor(Math.random() * 1e10)).padStart(10, "0")}`;

const DAY = 86_400_000;
const NOW = Date.now();
const seen = (daysAgo: number) => new Date(NOW - daysAgo * DAY);

// Scores are DELIBERATELY anti-correlated with recency: `lastSeenAt desc` (the
// route default) yields external→email→discord→phone, while `score desc` yields
// the exact reverse. An ordering assertion that silently fell back to the
// default sort therefore cannot pass.
const FIXTURES = [
  { label: "external", score: 10, daysAgo: 1 },
  { label: "email", score: 20, daysAgo: 2 },
  { label: "discord", score: 30, daysAgo: 3 },
  { label: "phone", score: 40, daysAgo: 4 },
  { label: "anon", score: 50, daysAgo: 5 },
] as const;

/** Exactly ONE identity column per fixture — the mutation proof depends on it. */
const identityColumns: Record<
  (typeof FIXTURES)[number]["label"],
  Partial<typeof contacts.$inferInsert>
> = {
  external: { externalId: `${RUN}-external` },
  email: { email: `${RUN}-email@identity.test` },
  discord: { discordId: `${RUN}-discord` },
  phone: { phone: PHONE },
  anon: { anonymousId: `${RUN}-anon` },
};

const idByLabel = new Map<string, string>();
for (const f of FIXTURES) {
  const [row] = await db
    .insert(contacts)
    .values({
      ...identityColumns[f.label],
      properties: { [RUN]: f.score },
      firstSeenAt: seen(f.daysAgo),
      lastSeenAt: seen(f.daysAgo),
    })
    .returning({ id: contacts.id });
  if (!row) throw new Error(`fixture ${f.label} did not insert`);
  idByLabel.set(f.label, row.id);
}
const labelById = new Map(
  [...idByLabel].map(([label, id]) => [id, label] as const),
);

afterAll(async () => {
  await db
    .delete(contacts)
    .where(inArray(contacts.id, [...idByLabel.values()]));
});

type ListBody = { contacts: { id: string }[]; total: number };

/**
 * Every request carries the run-scoped property filter, so `total` is the count
 * of THIS file's fixtures matching — never the whole table.
 */
async function list(params: Record<string, string> = {}): Promise<Response> {
  const qs = new URLSearchParams({
    propertyKey: RUN,
    propertyGte: "0",
    ...params,
  });
  return app.request(`/v1/admin/contacts?${qs}`, { headers: AUTH_HEADER });
}

async function listed(
  params: Record<string, string> = {},
): Promise<{ labels: string[]; total: number }> {
  const res = await list(params);
  expect(res.status).toBe(200);
  const body = (await res.json()) as ListBody;
  return {
    // A foreign row leaking into the window surfaces as `unknown:<uuid>` and
    // fails the assertion rather than passing silently.
    labels: body.contacts.map((c) => labelById.get(c.id) ?? `unknown:${c.id}`),
    total: body.total,
  };
}

describe("identity filter (PRD 01 T1)", () => {
  it("no `identity` parameter returns every contact, exactly as before", async () => {
    const { labels, total } = await listed();
    expect(labels).toEqual(["external", "email", "discord", "phone", "anon"]);
    expect(total).toBe(5);
  });

  it("identity=all is byte-identical to omitting the parameter (the server default)", async () => {
    expect(await listed({ identity: "all" })).toEqual(await listed());
  });

  it("identity=identified returns the four identified rows AND total===4", async () => {
    // THE count-consistency assertion. `total` must fall to 4 with the rows —
    // it is what goes red if a future edit filters the page query but not the
    // `count()`. It is also the assertion the four-way mutation proof targets:
    // drop ANY operand from the disjunction and one fixture leaves this set.
    const { labels, total } = await listed({ identity: "identified" });
    expect(labels).toEqual(["external", "email", "discord", "phone"]);
    expect(total).toBe(4);
  });

  it.each([
    ["external_id", "external"],
    ["email", "email"],
    ["discord_id", "discord"],
    ["phone", "phone"],
  ])("a contact holding ONLY %s counts as identified", async (_column, label) => {
    const { labels } = await listed({ identity: "identified" });
    expect(labels).toContain(label);
  });

  it("identity=anonymous returns exactly the never-identified complement", async () => {
    const { labels, total } = await listed({ identity: "anonymous" });
    expect(labels).toEqual(["anon"]);
    expect(total).toBe(1);
  });

  it("total(identified) + total(anonymous) === total(all) — the split is exhaustive", async () => {
    const [all, identified, anonymous] = await Promise.all([
      listed(),
      listed({ identity: "identified" }),
      listed({ identity: "anonymous" }),
    ]);
    expect(identified.total + anonymous.total).toBe(all.total);
  });

  it("identity composes with orderBy=property without changing its ordering semantics", async () => {
    const { labels, total } = await listed({
      identity: "identified",
      orderBy: "property",
      orderProperty: RUN,
      orderDir: "desc",
    });
    // Score order is the REVERSE of the default lastSeenAt order, so a sort
    // that fell back to the default cannot pass — and `anon` (the highest
    // score of all) is still excluded by the identity conjunct.
    expect(labels).toEqual(["phone", "discord", "email", "external"]);
    expect(total).toBe(4);
  });

  it("identity outside the enum responds 400", async () => {
    const res = await list({ identity: "bogus" });
    expect(res.status).toBe(400);
  });
});
