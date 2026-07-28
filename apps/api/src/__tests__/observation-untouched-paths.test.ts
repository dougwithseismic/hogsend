import { afterAll, describe, expect, it, vi } from "vitest";

// DB-touching test. The DEFAULT below is the repo-wide one every file in this
// directory shares, and it is what CI's service container listens on. Point a
// worktree at its own stack by exporting HOGSEND_TEST_DATABASE_URL — never by
// editing the default.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// The gateway-ingress route fails CLOSED on an unset secret (401 before the
// transform runs), so the connector leg needs one. Set BEFORE the engine import
// below: `env.ts` parses process.env once, at first import. Min length 32.
const INGRESS_SECRET = "t3-connector-ingress-secret-at-least-32-chars";
process.env.CONNECTOR_INGRESS_SECRET = INGRESS_SECRET;

// `ingestEvent` rethrows on a failed Hatchet push (it compensates by deleting
// the just-claimed `user_events` row), so the CONTAINER's hatchet has to be
// mocked, not just apps/api's module-level one.
vi.mock("../lib/hatchet.js", () => ({
  hatchet: {
    durableTask: vi.fn(() => ({
      run: vi.fn(),
      runNoWait: vi.fn(),
      runAndWait: vi.fn(),
    })),
    task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
    events: { push: vi.fn() },
    runs: { cancel: vi.fn(), get: vi.fn() },
    worker: vi.fn(),
  },
}));

const { contacts, emailPreferences, importJobs, userEvents } = await import(
  "@hogsend/db"
);
const { eq, inArray, like } = await import("drizzle-orm");
const {
  createApp,
  createHogsendClient,
  defineConnector,
  defineList,
  importContactsTask,
} = await import("@hogsend/engine");
type HogsendClient = ReturnType<typeof createHogsendClient>;

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

// RUN-namespaced so the shared dev DB never collides across files and the
// afterAll cleanup is precise.
const RUN = `obsu-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const uid = (label: string) => `${RUN}-${label}`;
const mail = (label: string) => `${RUN}-${label}@example.test`;

// A topic list so `/v1/lists/:id/subscribe` has a real id to write. The
// `defaultOptIn: false` shape is the one whose subscribe must resolve — and
// therefore CREATE — the contact before the category write.
const sweepList = defineList({
  id: "t3-sweep-list",
  name: "T3 sweep list",
  defaultOptIn: false,
});

// A discordId-ONLY gateway connector. This is the shape PRD 02 deliberately
// left out of the opt-out list: a Discord snowflake is never a canonical key
// (`contactKey(row) = external_id ?? anonymous_id ?? id`), so a refusal here
// would key history on a string today's code never writes, with no repoint
// path back — a D8 violation. The contract this pins is that it STILL creates.
const DISCORD_EVENT = `${RUN}.discord.message`;
const discordGateway = defineConnector({
  meta: {
    id: "t3-discordish",
    name: "T3 Discord-ish gateway",
    transport: "gateway",
  },
  credential: { kind: "derived" },
  async transform(payload: { snowflake: string }) {
    return {
      event: DISCORD_EVENT,
      discordId: payload.snowflake,
      eventProperties: { via: "gateway" },
    };
  },
});

const container = createHogsendClient({
  lists: [sweepList],
  connectors: [discordGateway],
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db } = container;

const ADMIN_HEADERS = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
  "Content-Type": "application/json",
};

const createdJobIds: string[] = [];
const createdDiscordIds: string[] = [];

afterAll(async () => {
  // The discord leg keys `user_events.user_id` on the minted row's uuid (that
  // is exactly the D8 problem), so collect those ids before dropping the rows.
  if (createdDiscordIds.length > 0) {
    const rows = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(inArray(contacts.discordId, createdDiscordIds));
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      await db.delete(userEvents).where(inArray(userEvents.userId, ids));
      await db.delete(contacts).where(inArray(contacts.id, ids));
    }
  }

  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  await db
    .delete(emailPreferences)
    .where(like(emailPreferences.email, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.email, `${RUN}-%`));
  if (createdJobIds.length > 0) {
    await db.delete(importJobs).where(inArray(importJobs.id, createdJobIds));
  }
});

/** Live contact rows owning `email` — the create-or-not oracle for email keys. */
async function contactsByEmail(email: string) {
  return db
    .select({ id: contacts.id, email: contacts.email })
    .from(contacts)
    .where(eq(contacts.email, email));
}

/** Live contact rows owning `externalId`. */
async function contactsByExternalId(externalId: string) {
  return db
    .select({ id: contacts.id, externalId: contacts.externalId })
    .from(contacts)
    .where(eq(contacts.externalId, externalId));
}

// ===========================================================================
// PRD 02 T3 — the regression sweep.
//
// PRD 02 narrows creation at exactly THREE sites (publishable `/v1/events`,
// the anon leg of `/v1/t/arrive`, and `sendFeedItem` on a miss). Every other
// caller is deliberately untouched, and each `it` below is the tripwire that a
// future "fix" did not generalise the refusal past those three.
//
// These are pins on EXISTING behaviour, so they are green on arrival. Their
// non-vacuity is proved the other way round, by mutation: wiring the refusal
// into any one of these four call sites turns exactly its own test red.
// ===========================================================================

describe("untouched path — POST /v1/lists/:id/subscribe (secret key)", () => {
  it("a novel email still mints the contact", async () => {
    // A list subscribe is an explicit server-side ASSERTION of a durable
    // identity (D1), and the email it carries is not a canonical key anyway, so
    // refusal here would ALSO be a D8 misuse throw rather than a silent no-op.
    const email = mail("list-subscribe");
    expect(await contactsByEmail(email)).toHaveLength(0);

    const res = await app.request("/v1/lists/t3-sweep-list/subscribe", {
      method: "POST",
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ email }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      list: "t3-sweep-list",
      subscribed: true,
    });

    const rows = await contactsByEmail(email);
    expect(rows).toHaveLength(1);

    // …and the membership actually landed, which is what needed the row: the
    // category write keys on `(external_id ?? contact.id, email)`.
    const [pref] = await db
      .select({ categories: emailPreferences.categories })
      .from(emailPreferences)
      .where(eq(emailPreferences.email, email));
    expect(pref?.categories).toMatchObject({ "t3-sweep-list": true });
  });
});

describe("untouched path — POST /v1/admin/contacts", () => {
  it("a novel externalId still mints the contact", async () => {
    // The admin create IS the explicit-intent path in D1's own wording ("or
    // when a server-side/secret-key caller explicitly asks"). If this ever
    // stops creating, the Studio's create-contact button silently does nothing.
    const externalId = uid("admin-create");
    expect(await contactsByExternalId(externalId)).toHaveLength(0);

    const res = await app.request("/v1/admin/contacts", {
      method: "POST",
      headers: ADMIN_HEADERS,
      body: JSON.stringify({
        externalId,
        properties: { plan: "pro" },
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.contact.externalId).toBe(externalId);
    expect(body.contact.id).toBeTruthy();

    const rows = await contactsByExternalId(externalId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(body.contact.id);
  });
});

describe("untouched path — the import-contacts task", () => {
  it("both an externalId row and an email-only row still mint", async () => {
    // Reach the task's registered `fn` directly: the route is fire-and-forget
    // (`runNoWait`) onto a worker, so driving the HTTP endpoint would assert
    // nothing about the work. `definition._tasks[0]` is where
    // `hatchet.task({ name, fn })` parks its options.
    const taskFn = importContactsTask.definition._tasks[0]?.fn;
    if (typeof taskFn !== "function") {
      throw new Error("import-contacts task fn not reachable");
    }

    const externalId = uid("import-external");
    const email = mail("import-email");
    expect(await contactsByExternalId(externalId)).toHaveLength(0);
    expect(await contactsByEmail(email)).toHaveLength(0);

    const [job] = await db
      .insert(importJobs)
      .values({ format: "json", fileName: `${RUN}.json` })
      .returning({ id: importJobs.id });
    if (!job) throw new Error("failed to seed the import job row");
    createdJobIds.push(job.id);

    const result = await taskFn(
      {
        jobId: job.id,
        format: "json",
        data: JSON.stringify([
          { externalId, properties: { seat: "1" } },
          { email },
        ]),
      },
      // The task body never touches the Hatchet context.
      undefined as never,
    );

    // The rows FIRST: an import that quietly resolves-without-minting can
    // still report `processed`, so the contact oracle is the load-bearing
    // assertion and must be the one that fails first.
    expect(await contactsByExternalId(externalId)).toHaveLength(1);
    expect(await contactsByEmail(email)).toHaveLength(1);
    expect(result).toMatchObject({
      status: "completed",
      processed: 2,
      failed: 0,
    });

    const [row] = await db
      .select({
        status: importJobs.status,
        processedRows: importJobs.processedRows,
      })
      .from(importJobs)
      .where(eq(importJobs.id, job.id));
    expect(row?.status).toBe("completed");
    expect(row?.processedRows).toBe(2);
  });
});

describe("untouched path — discordId-only connector ingress", () => {
  it("still mints, and keys history on the minted row's uuid (why D8 forbids refusing)", async () => {
    // The load-bearing one. Connector ingress was DROPPED from PRD 02's opt-out
    // list on purpose: a snowflake never becomes `contactKey`, so today's key
    // for this event is the freshly-minted row's uuid. A refusal could not
    // reproduce that string, and pre-link Discord history + `journey_states`
    // would be orphaned with no repoint path.
    const snowflake = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    createdDiscordIds.push(snowflake);

    const before = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.discordId, snowflake));
    expect(before).toHaveLength(0);

    const res = await app.request("/v1/connectors/t3-discordish/ingress", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hogsend-ingress-secret": INGRESS_SECRET,
      },
      body: JSON.stringify({ snowflake }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, event: DISCORD_EVENT });

    const rows = await db
      .select({ id: contacts.id, discordId: contacts.discordId })
      .from(contacts)
      .where(eq(contacts.discordId, snowflake));
    expect(rows).toHaveLength(1);

    // The uuid IS the key — this is the assertion that makes the D8 rationale
    // concrete rather than a footnote.
    const events = await db
      .select({ event: userEvents.event, userId: userEvents.userId })
      .from(userEvents)
      .where(eq(userEvents.userId, rows[0]?.id ?? ""));
    expect(events.map((e) => e.event)).toContain(DISCORD_EVENT);
    expect(events[0]?.userId).toBe(rows[0]?.id);
  });
});
