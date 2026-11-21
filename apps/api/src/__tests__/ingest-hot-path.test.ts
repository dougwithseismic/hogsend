/**
 * PRD 09 part A — the database cost of the two hottest engine paths.
 *
 * 1. Statement budgets, counted on the wire with `countQueries` (every
 *    statement counts, BEGIN/COMMIT and advisory locks included):
 *      (a) a WARM ingest — known contact, one `userId`, no groups /
 *          conversions / funnels / buckets, no orphan history.
 *            before: 17 statements (8 of them no-op orphan adoption)
 *            after:  10 (adoption is one existence probe)
 *      (b) one tracked send through the container's mailer to a known
 *          contact: 6 statements before and after (part A makes the
 *          preference read an index probe; it does not remove a statement).
 *    The bounds are upper bounds at the new numbers, so a regression fails.
 * 2. The orphan-adoption gate opens for an orphan in ANY of the five tables.
 * 3. EXPLAIN pins: the per-send preference read uses
 *    `email_preferences_email_idx`; the campaign anti-join's `lower(email)`
 *    lookup uses `email_preferences_lower_email_idx`.
 * 4. `event` conditions answer exists / not_exists with EXISTS and cap
 *    count comparisons, deciding exactly as the full count does.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  type CountedStatement,
  countQueries,
  describeStatements,
} from "./query-counter.js";

// DB-touching test. Point a worktree at its own stack with
// HOGSEND_TEST_DATABASE_URL — never by editing the default.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { hatchetMock } = vi.hoisted(() => {
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
      events: { push: vi.fn() },
      runs: { cancel: vi.fn(), get: vi.fn() },
      worker: vi.fn(),
    },
  });
  return { hatchetMock: factory };
});
vi.mock("../../../../packages/engine/src/lib/hatchet.ts", () => hatchetMock());
vi.mock("../lib/hatchet.js", () => hatchetMock());

const {
  bucketMemberships,
  contactAliases,
  contacts,
  emailPreferences,
  emailSends,
  journeyStates,
  userEvents,
} = await import("@hogsend/db");
const { eq, like, or, sql } = await import("drizzle-orm");
const { evaluateCondition, evaluateEventCondition } = await import(
  "@hogsend/core"
);
type EventCondition = import("@hogsend/core").EventCondition;
const { createHogsendClient, hatchet, ingestEvent, resolveOrCreateContact } =
  await import("@hogsend/engine");
type EmailProvider = import("@hogsend/engine").EmailProvider;
const { templates } = await import("../emails/index.js");
const { lists } = await import("../lists/index.js");

const fakeProvider: EmailProvider = {
  meta: { id: "resend", name: "Fake Resend" },
  send: async () => ({ id: `msg-${randomUUID()}` }),
  sendBatch: async () => ({ results: [] }),
  verifyWebhook: () => {
    throw new Error("unused");
  },
  parseWebhook: () => {
    throw new Error("unused");
  },
};

const container = createHogsendClient({
  email: { provider: fakeProvider, templates },
  lists,
});
const { db, registry, logger, dbClient } = container;

const RUN = `hot-${randomUUID().slice(0, 8)}`;
const uid = (label: string) => `${RUN}-${label}`;
const mail = (label: string) => `${RUN}-${label}@example.com`;

/** The measured budgets (PRD 09 part A). Lower them as later parts land. */
const WARM_INGEST_BUDGET = 10;
const TRACKED_SEND_BUDGET = 6;

afterAll(async () => {
  const key = `${RUN}-%`;
  await db.delete(userEvents).where(like(userEvents.userId, key));
  await db
    .delete(emailSends)
    .where(or(like(emailSends.toEmail, key), like(emailSends.userId, key)));
  await db.delete(journeyStates).where(like(journeyStates.userId, key));
  await db.delete(bucketMemberships).where(like(bucketMemberships.userId, key));
  await db
    .delete(emailPreferences)
    .where(
      or(like(emailPreferences.email, key), like(emailPreferences.userId, key)),
    );
  const owned = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      or(
        like(contacts.externalId, key),
        like(contacts.anonymousId, key),
        like(contacts.email, key),
      ),
    );
  for (const row of owned) {
    await db.delete(contactAliases).where(eq(contactAliases.contactId, row.id));
    await db.delete(contacts).where(eq(contacts.id, row.id));
  }
  await dbClient.end({ timeout: 5 }).catch(() => {});
});

function ingest(userId: string, event: string) {
  return ingestEvent({
    db,
    registry,
    hatchet,
    logger,
    event: { event, userId, userEmail: "", eventProperties: {} },
  });
}

const isOrphanProbe = (s: CountedStatement) =>
  s.sql.includes("exists (select 1 from") && s.sql.includes("is null");
const isAdoptionStamp = (s: CountedStatement) =>
  /^update "(user_events|email_sends|bucket_memberships)" set "contact_id"/.test(
    s.sql,
  );

describe("PRD 09 — statement budgets", () => {
  it("(a) a warm ingest for a known contact with no orphan history", async () => {
    const userId = uid("warm");
    await resolveOrCreateContact({ db, userId, email: mail("warm") });
    // Warm-up ingest: settles aliases and any first-touch writes.
    await ingest(userId, `${RUN}.warmup`);

    const counted = await countQueries(dbClient, () =>
      ingest(userId, `${RUN}.viewed`),
    );
    expect(counted.result.stored).toBe(true);

    const listing = describeStatements(counted.statements);
    expect(counted.count, listing).toBeLessThanOrEqual(WARM_INGEST_BUDGET);
    // Adoption is exactly one probe and none of its eight statements.
    expect(counted.statements.filter(isOrphanProbe), listing).toHaveLength(1);
    expect(counted.statements.filter(isAdoptionStamp), listing).toHaveLength(0);
  });

  it("(b) one tracked send to a known contact", async () => {
    const userId = uid("send");
    const to = mail("send");
    await resolveOrCreateContact({ db, userId, email: to });

    const counted = await countQueries(dbClient, () =>
      container.emailService.send({
        template: "welcome",
        to,
        props: { name: "Ada" },
        userId,
      }),
    );
    expect(counted.result.status).toBe("sent");
    expect(
      counted.count,
      describeStatements(counted.statements),
    ).toBeLessThanOrEqual(TRACKED_SEND_BUDGET);
  });
});

describe("PRD 09 — the orphan-adoption gate opens for every table", () => {
  // One orphan row in ONE table under a fresh anonymous key, then an identify
  // that claims the key. If the probe forgot a table, that table's row would
  // stay contactless and this would fail for it alone.
  const seeds: Record<
    string,
    {
      seed: (key: string) => Promise<unknown>;
      owner: (key: string) => Promise<string | null | undefined>;
    }
  > = {
    user_events: {
      seed: (key) =>
        db.insert(userEvents).values({ userId: key, event: `${RUN}.orphan` }),
      owner: async (key) =>
        (
          await db
            .select({ contactId: userEvents.contactId })
            .from(userEvents)
            .where(eq(userEvents.userId, key))
        )[0]?.contactId,
    },
    email_sends: {
      seed: (key) =>
        db.insert(emailSends).values({
          userId: key,
          templateKey: "welcome",
          fromEmail: mail("from"),
          toEmail: mail(`orphan-send-${key.slice(-6)}`),
          subject: "orphan",
          status: "sent",
        }),
      owner: async (key) =>
        (
          await db
            .select({ contactId: emailSends.contactId })
            .from(emailSends)
            .where(eq(emailSends.userId, key))
        )[0]?.contactId,
    },
    journey_states: {
      seed: (key) =>
        db.insert(journeyStates).values({
          userId: key,
          userEmail: "",
          journeyId: `${RUN}-journey`,
          currentNodeId: "start",
          status: "completed",
        }),
      owner: async (key) =>
        (
          await db
            .select({ contactId: journeyStates.contactId })
            .from(journeyStates)
            .where(eq(journeyStates.userId, key))
        )[0]?.contactId,
    },
    bucket_memberships: {
      seed: (key) =>
        db.insert(bucketMemberships).values({
          userId: key,
          bucketId: `${RUN}-bucket`,
          status: "active",
        }),
      owner: async (key) =>
        (
          await db
            .select({ contactId: bucketMemberships.contactId })
            .from(bucketMemberships)
            .where(eq(bucketMemberships.userId, key))
        )[0]?.contactId,
    },
    email_preferences: {
      seed: (key) =>
        db.insert(emailPreferences).values({
          userId: key,
          email: mail(`orphan-pref-${key.slice(-6)}`),
          unsubscribedAll: true,
        }),
      owner: async (key) =>
        (
          await db
            .select({ contactId: emailPreferences.contactId })
            .from(emailPreferences)
            .where(eq(emailPreferences.userId, key))
        )[0]?.contactId,
    },
  };

  for (const [table, { seed, owner }] of Object.entries(seeds)) {
    it(`an orphan in ${table} is adopted on identify`, async () => {
      const anon = uid(`anon-${table}`);
      await seed(anon);
      expect(await owner(anon)).toBeNull();

      const contact = await resolveOrCreateContact({
        db,
        userId: uid(`user-${table}`),
        anonymousId: anon,
      });

      expect(await owner(anon)).toBe(contact.id);
    });
  }
});

describe("PRD 09 — EXPLAIN pins on email_preferences", () => {
  it("the per-send preference read uses email_preferences_email_idx", async () => {
    const userId = uid("explain");
    const to = mail("explain");
    await resolveOrCreateContact({ db, userId, email: to });

    // Capture the statement the real send pipeline issues, so this pins THE
    // read rather than a hand copy of it.
    const counted = await countQueries(dbClient, () =>
      container.emailService.send({
        template: "welcome",
        to,
        props: { name: "Ada" },
        userId,
      }),
    );
    const read = counted.statements.find((s) =>
      /from "email_preferences" where/.test(s.sql),
    );
    expect(read, describeStatements(counted.statements)).toBeDefined();
    if (!read) return;
    expect(read.sql).toContain('"email_preferences"."email" = $1');

    // The test table is tiny, so the planner would pick a seq scan on cost
    // alone. `enable_seqscan = off` only penalizes one (it cannot forbid it),
    // so an unusable index still shows up as a Seq Scan here. SET LOCAL keeps
    // it on this transaction's connection only.
    const plan = await dbClient.begin(async (tx) => {
      await tx`SET LOCAL enable_seqscan = off`;
      const rows = await tx.unsafe(
        `EXPLAIN ${read.sql}`,
        read.params as never[],
      );
      return rows.map((r) => (r as Record<string, string>)["QUERY PLAN"]);
    });
    const text = plan.join("\n");
    expect(text).toContain("email_preferences_email_idx");
    expect(text).not.toContain("Seq Scan");
  });

  it("the campaign anti-join's lower(email) lookup uses email_preferences_lower_email_idx", async () => {
    // The inner side of the correlated NOT EXISTS in send-campaign.ts (bucket
    // and opt-out-list resolvers) and campaigns/cohort-sql.ts, per recipient.
    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const rows = (await tx.execute(
        sql`EXPLAIN SELECT 1 FROM ${emailPreferences}
            WHERE lower(${emailPreferences.email}) = ${mail("anti-join")}
              AND (${emailPreferences.unsubscribedAll} = true
                   OR ${emailPreferences.suppressed} = true)`,
      )) as unknown as Array<Record<string, string>>;
      return rows.map((r) => r["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain("email_preferences_lower_email_idx");
    expect(plan).toMatch(/Index Cond: \(lower\(email\) =/);
  });
});

describe("PRD 09 — event conditions use EXISTS and capped counts", () => {
  const userId = uid("events");
  const present = `${RUN}.present`;
  const absent = `${RUN}.absent`;
  let contactId = "";

  const seedOnce = (() => {
    let done: Promise<void> | undefined;
    return () => {
      done ??= (async () => {
        const contact = await resolveOrCreateContact({ db, userId });
        contactId = contact.id;
        await db.insert(userEvents).values(
          [1, 2, 3].map(() => ({
            userId,
            contactId: contact.id,
            event: present,
          })),
        );
      })();
      return done;
    };
  })();

  const cases: Array<Omit<EventCondition, "type" | "eventName">> = [
    { check: "exists" },
    { check: "not_exists" },
    { check: "count" },
    { check: "exists", within: { hours: 24 } },
    { check: "not_exists", within: { hours: 24 } },
    ...(["gt", "gte", "lt", "lte", "eq"] as const).flatMap((operator) =>
      [-1, 0, 2, 2.5, 3, 3.5, 4].map((value) => ({
        check: "count" as const,
        operator,
        value,
      })),
    ),
  ];

  for (const subject of ["contact", "text key"] as const) {
    it(`decides exactly as the full count does (${subject} arm)`, async () => {
      await seedOnce();
      const ctx = {
        db,
        userId,
        contactId: subject === "contact" ? contactId : null,
        journeyContext: {},
      };
      for (const eventName of [present, absent]) {
        for (const c of cases) {
          const condition = { type: "event", eventName, ...c } as const;
          const fast = await evaluateCondition({ condition, ctx });
          const exact = await evaluateEventCondition({ condition, ctx });
          expect(fast, JSON.stringify(condition)).toBe(exact.matched);
        }
      }
    });
  }

  it("exists / not_exists issue one EXISTS probe and no count", async () => {
    await seedOnce();
    const ctx = { db, userId, contactId, journeyContext: {} };
    for (const check of ["exists", "not_exists"] as const) {
      const counted = await countQueries(dbClient, () =>
        evaluateCondition({
          condition: { type: "event", eventName: present, check },
          ctx,
        }),
      );
      expect(counted.result).toBe(check === "exists");
      expect(counted.count).toBe(1);
      expect(counted.statements[0]?.sql).toMatch(/^select exists \(/);
      expect(counted.statements[0]?.sql).not.toContain("count(");
    }
  });

  it("a count comparison counts at most floor(value) + 1 rows", async () => {
    await seedOnce();
    const ctx = { db, userId, contactId, journeyContext: {} };
    const counted = await countQueries(dbClient, () =>
      evaluateCondition({
        condition: {
          type: "event",
          eventName: present,
          check: "count",
          operator: "gte",
          value: 2,
        },
        ctx,
      }),
    );
    expect(counted.result).toBe(true);
    expect(counted.count).toBe(1);
    const [statement] = counted.statements;
    expect(statement?.sql).toContain(" limit $");
    expect(statement?.params.at(-1)).toBe(3);
  });

  it("ctx.history.hasEvent's count stays exact (evaluateEventCondition)", async () => {
    await seedOnce();
    const result = await evaluateEventCondition({
      condition: { type: "event", eventName: present, check: "exists" },
      ctx: { db, userId, contactId, journeyContext: {} },
    });
    expect(result).toEqual({ matched: true, count: 3 });
  });
});
