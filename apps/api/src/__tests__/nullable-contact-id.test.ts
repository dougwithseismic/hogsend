/**
 * PRD 07 T4 — `contact_id` is LEGALLY nullable on the history tables, and stays
 * that way. The audit proved NOT NULL unreachable on all five: a CONTACTLESS
 * subject (a string key nobody ever minted a CRM row for) is a permanent,
 * supported state, so these are the behaviours a future migration would break.
 *
 * `user_events` and `bucket_memberships` are already pinned by
 * `observation-paths.test.ts` / `observation-bucket-expiry.test.ts`. This file
 * covers the two that were NOT:
 *
 *   1. `journey_states` — a refused (contactless) event still reaches Hatchet,
 *      so the enrollment row lands with `contact_id NULL` and the journey RUNS.
 *   2. `email_preferences` — an unsubscribe whose key owns no contact writes
 *      the row with `contact_id NULL`, and every read path honours the opt-out
 *      through `bySubject`'s else-arm (`user_id`).
 *
 * LAW for this file: every fixture is CONTACTLESS. No test here may create a
 * live contact whose canonical key matches a null fixture's `user_id` — the
 * global backfill sweep would stamp it and quietly hollow out the assertions.
 */
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

type CapturedFn = (input: unknown, ctx: unknown) => Promise<unknown>;
type Pushed = { name: string; payload: Record<string, unknown> };

// ONE shared hatchet double behind all three specifiers, so the durable-task
// fns captured at `defineJourney` time and the pushes `ingestEvent` makes are
// observed on the same object (the container resolves the engine singleton).
const { mockFns, pushes, hatchetMock } = vi.hoisted(() => {
  const mockFns: Record<string, CapturedFn> = {};
  const pushes: { name: string; payload: Record<string, unknown> }[] = [];
  const hatchet = {
    durableTask: vi.fn((cfg: { name: string; fn: CapturedFn }) => {
      mockFns[cfg.name] = cfg.fn;
      return { run: vi.fn(), runNoWait: vi.fn(), runAndWait: vi.fn() };
    }),
    task: vi.fn((cfg: { name: string; fn: CapturedFn }) => {
      mockFns[cfg.name] = cfg.fn;
      return { run: vi.fn(), runNoWait: vi.fn(async () => ({})) };
    }),
    events: {
      push: vi.fn(async (name: string, payload: Record<string, unknown>) => {
        pushes.push({ name, payload });
      }),
    },
    runs: { cancel: vi.fn(async () => {}), get: vi.fn() },
    worker: vi.fn(),
  };
  return { mockFns, pushes, hatchetMock: () => ({ hatchet }) };
});
vi.mock("../../../../packages/engine/src/lib/hatchet.ts", hatchetMock);
vi.mock("../../../../packages/engine/src/lib/hatchet.js", hatchetMock);
vi.mock("../lib/hatchet.js", hatchetMock);

const { contacts, emailPreferences, journeyStates, userEvents } = await import(
  "@hogsend/db"
);
const { and, eq, like, or } = await import("drizzle-orm");
const {
  checkEmailPreferences,
  createApp,
  createHogsendClient,
  defineJourney,
  ingestEvent,
  readRecipientPreferences,
} = await import("@hogsend/engine");
const {
  generatePreferenceCenterUrl,
  generateUnsubscribeToken,
  generateUnsubscribeUrl,
} = await import("@hogsend/email");

const RUN = `nullct-${randomUUID().slice(0, 8)}`;
const uid = (label: string) => `${RUN}-${label}`;

const JOURNEY_ID = uid("journey");
const TRIGGER_EVENT = `${RUN}.observed`;

// Proof the run body really executed for a contactless subject — the
// checkpoint writes `current_node_id` on the very row under test.
let ranFor: string[] = [];
const contactlessJourney = defineJourney({
  meta: {
    id: JOURNEY_ID,
    name: "Contactless subject journey",
    enabled: true,
    trigger: { event: TRIGGER_EVENT },
    entryLimit: "unlimited",
    suppress: { hours: 0 },
  },
  run: async (user, ctx) => {
    ranFor.push(user.id);
    await ctx.checkpoint("ran");
  },
});

const container = createHogsendClient({ journeys: [contactlessJourney] });
const app = createApp(container);
const { db, env, hatchet, logger, registry } = container;

const BASE_URL = "http://localhost:3002";

const journeyFn = (id: string): CapturedFn => {
  const fn = mockFns[`journey-${id}`];
  if (!fn) throw new Error(`journey fn for ${id} was not captured`);
  return fn;
};

/** The minimal Hatchet durable-task ctx a journey run needs. */
const runCtx = (runId: string) => ({
  workflowRunId: () => runId,
  sleepFor: async () => ({}),
  waitFor: async () => ({}),
  now: async () => new Date(),
});

/** Every LIVE contact owning `key` as either identity column. */
const contactsForKey = (key: string) =>
  db
    .select({ id: contacts.id })
    .from(contacts)
    .where(or(eq(contacts.externalId, key), eq(contacts.anonymousId, key)));

const stateRows = (userId: string) =>
  db
    .select()
    .from(journeyStates)
    .where(
      and(
        eq(journeyStates.journeyId, JOURNEY_ID),
        eq(journeyStates.userId, userId),
      ),
    );

const prefsFor = (userId: string) =>
  db.select().from(emailPreferences).where(eq(emailPreferences.userId, userId));

const lastPush = (name: string): Pushed => {
  const found = [...pushes].reverse().find((p) => p.name === name);
  if (!found) throw new Error(`no hatchet push captured for ${name}`);
  return found;
};

afterAll(async () => {
  await db
    .delete(journeyStates)
    .where(like(journeyStates.journeyId, `${RUN}-%`));
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  await db
    .delete(emailPreferences)
    .where(
      or(
        like(emailPreferences.userId, `${RUN}-%`),
        like(emailPreferences.email, `${RUN}-%`),
      ),
    );
  // Nothing here should ever mint a contact — this sweep is the safety net that
  // keeps a regression from leaking rows into the shared DB.
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

describe("journey_states.contact_id — a contactless subject enrolls and runs", () => {
  it("a refused anon event enrolls with contact_id NULL and the journey executes", async () => {
    const anon = uid("anon");
    ranFor = [];

    // The refusing ingest: an observation-only caller (`allowCreate: false`)
    // whose anon key owns no contact row. The resolve REFUSES to mint, so
    // nothing downstream has a `contacts.id` to stamp.
    const result = await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      event: {
        event: TRIGGER_EVENT,
        anonymousId: anon,
        eventProperties: { seen: true },
      },
      allowCreate: false,
    });
    expect(result.stored).toBe(true);
    // D8: the canonical key survives a refusal — that is what every history
    // table keys on when there is no contact.
    expect(result.contactKey).toBe(anon);

    // The premise, asserted rather than assumed: this subject is contactless.
    expect(await contactsForKey(anon)).toHaveLength(0);

    // The push carries NO `contactId` key at all (absent, not JSON null) —
    // that omission is the only reason the enrollment below has nothing to
    // stamp. `execute-journey-run` falls back to a probe on a MISSING key.
    const pushed = lastPush(TRIGGER_EVENT);
    expect(pushed.payload.userId).toBe(anon);
    expect(pushed.payload).not.toHaveProperty("contactId");

    // Hatchet routes that payload to the journey task; run it verbatim.
    const outcome = await journeyFn(JOURNEY_ID)(
      pushed.payload,
      runCtx(`${RUN}-run-anon`),
    );
    // The load-bearing half: the run is NOT skipped or thrown. Every guard
    // (entry limit, preferences, exits) tolerated a null contact.
    expect(outcome).toMatchObject({ status: "completed" });
    expect(ranFor).toEqual([anon]);

    const rows = await stateRows(anon);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBeNull();
    // A real, complete enrollment — the null stamp degraded nothing. The
    // checkpoint proves the run body itself reached the row.
    expect(rows[0]?.status).toBe("completed");
    expect(rows[0]?.currentNodeId).toBe("ran");
  });

  it("re-entry keeps stamping NULL while the subject stays contactless", async () => {
    // A second run on the SAME key: the enrollment probe re-runs at every
    // insert, so a NOT NULL migration would fail here too, not just on the
    // first sighting. `unlimited` entry limit ⇒ a fresh row per run.
    const anon = uid("anon-again");
    ranFor = [];

    for (const attempt of ["a", "b"]) {
      await ingestEvent({
        db,
        registry,
        hatchet,
        logger,
        event: {
          event: TRIGGER_EVENT,
          anonymousId: anon,
          eventProperties: { attempt },
        },
        allowCreate: false,
      });
      await journeyFn(JOURNEY_ID)(
        lastPush(TRIGGER_EVENT).payload,
        runCtx(`${RUN}-run-again-${attempt}`),
      );
    }

    const rows = await stateRows(anon);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.contactId === null)).toBe(true);
    expect(rows.every((r) => r.status === "completed")).toBe(true);
    expect(ranFor).toEqual([anon, anon]);
    expect(await contactsForKey(anon)).toHaveLength(0);
  });
});

describe("email_preferences.contact_id — a contactless opt-out is honoured", () => {
  it("an unsubscribe whose key owns no contact writes NULL and still suppresses", async () => {
    const ghostKey = uid("pref-ghost");
    const ghostEmail = `${uid("pref-ghost")}@example.test`;

    // The premise: neither the key nor the address belongs to anybody. This is
    // the ordinary shape for an imported/legacy address unsubscribing — the
    // opt-out MUST land, contact or no contact.
    expect(await contactsForKey(ghostKey)).toHaveLength(0);

    // The REAL hosted surface: a signed token → GET → the route calls
    // `upsertEmailPreference` with no contact id, and its internal
    // `lookupContactIdByKey` fallback MISSES.
    const unsubUrl = generateUnsubscribeUrl({
      baseUrl: BASE_URL,
      secret: env.BETTER_AUTH_SECRET,
      externalId: ghostKey,
      email: ghostEmail,
    });
    const res = await app.request(unsubUrl.replace(BASE_URL, ""));
    expect(res.status).toBe(200);

    const rows = await prefsFor(ghostKey);
    expect(rows).toHaveLength(1);
    // The preference itself is fully written — the missing contact degraded
    // only the bookkeeping column.
    expect(rows[0]?.unsubscribedAll).toBe(true);
    expect(rows[0]?.contactId).toBeNull();

    // Read leg 1 — the journey enrollment guard. `contactId: null` sends it
    // down `bySubject`'s else-arm (`user_id`), which must still find the row.
    expect(
      await checkEmailPreferences({ db, userId: ghostKey, contactId: null }),
    ).toEqual({ unsubscribed: true });

    // Read leg 2 — the mailer's recipient gate, the one that actually stops
    // mail leaving. Both key shapes are honoured.
    const byBoth = await readRecipientPreferences(db, {
      email: ghostEmail,
      userId: ghostKey,
      contactId: null,
    });
    expect(byBoth.unsubscribedAll).toBe(true);
    const byEmailOnly = await readRecipientPreferences(db, {
      email: ghostEmail,
      contactId: null,
    });
    expect(byEmailOnly.unsubscribedAll).toBe(true);

    // Read leg 3 — the hosted preference center renders the null-stamped row
    // instead of 500ing or showing the subject as still subscribed.
    const centerUrl = generatePreferenceCenterUrl({
      baseUrl: BASE_URL,
      secret: env.BETTER_AUTH_SECRET,
      externalId: ghostKey,
      email: ghostEmail,
    });
    const page = await app.request(centerUrl.replace(BASE_URL, ""));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Unsubscribed from all");

    // …and the write minted nothing: still a contactless subject.
    expect(await contactsForKey(ghostKey)).toHaveLength(0);
  });

  it("a later resubscribe on the same NULL row round-trips", async () => {
    // The conflict arm of the same writer. A NOT NULL column would make this
    // update impossible to reach for a contactless subject, stranding them
    // opted out forever.
    const ghostKey = uid("pref-toggle");
    const ghostEmail = `${uid("pref-toggle")}@example.test`;
    const tokenUrl = (action: "unsubscribe" | "resubscribe") => {
      const token = generateUnsubscribeToken({
        secret: env.BETTER_AUTH_SECRET,
        externalId: ghostKey,
        email: ghostEmail,
        action,
      });
      return `/v1/email/unsubscribe?token=${encodeURIComponent(token)}`;
    };

    expect((await app.request(tokenUrl("unsubscribe"))).status).toBe(200);
    expect((await prefsFor(ghostKey))[0]?.unsubscribedAll).toBe(true);

    expect((await app.request(tokenUrl("resubscribe"))).status).toBe(200);

    const rows = await prefsFor(ghostKey);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.unsubscribedAll).toBe(false);
    expect(rows[0]?.contactId).toBeNull();
    expect(
      await checkEmailPreferences({ db, userId: ghostKey, contactId: null }),
    ).toEqual({ unsubscribed: false });
  });
});
