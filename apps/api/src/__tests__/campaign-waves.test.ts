import type {
  CampaignSendStep,
  CampaignStep,
  EmailProvider,
  SendEmailOptions,
} from "@hogsend/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// DB-touching test: point at the real docker TimescaleDB (mirrors
// campaigns-dataplane.test.ts), overriding the vitest.config placeholder
// DATABASE_URL. The `sendCampaignTask.fn` body opens its OWN
// `createDatabase({ url: process.env.DATABASE_URL })` connection, so this MUST
// be set before the task runs.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Config-preserving Hatchet mock (mirrors campaigns-dataplane.test.ts). The
// campaign task is a module-level `hatchet.task({ name, fn })` built off the
// ENGINE's own `lib/hatchet.ts` at import. We mock BOTH the engine's hatchet
// (so importing `@hogsend/engine` never dials a live gRPC engine and the
// task's `.fn` is preserved for direct invocation) AND the API's
// `../lib/hatchet.js`. The `...config` spread keeps `sendCampaignTask.fn` (the
// REAL wave-runtime body) callable while `.runNoWait` (reaper re-enqueue) and
// `.schedule` (the park's punctual next-step run) are no-op spies.
const { runNoWaitSpy, scheduleSpy, hatchetMock } = vi.hoisted(() => {
  const runNoWait = vi.fn(async (_input: { campaignId: string }) => ({}));
  const schedule = vi.fn(
    async (_at: Date, _input: { campaignId: string }) => ({}),
  );
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
        runNoWait,
        schedule,
      })),
      events: { push: vi.fn() },
      runs: { cancel: vi.fn(), get: vi.fn() },
      worker: vi.fn(),
    },
  });
  return {
    runNoWaitSpy: runNoWait,
    scheduleSpy: schedule,
    hatchetMock: factory,
  };
});

vi.mock("../../../../packages/engine/src/lib/hatchet.ts", () => hatchetMock());
vi.mock("../lib/hatchet.js", () => hatchetMock());

const {
  campaignRecipients,
  campaigns,
  contacts,
  emailPreferences,
  emailSends,
} = await import("@hogsend/db");
const { userEvents } = await import("@hogsend/db");
const { and, eq, inArray, like } = await import("drizzle-orm");
const { days, minutes } = await import("@hogsend/core");
const {
  createHogsendClient,
  defineCampaign,
  defineList,
  reapStuckCampaignsTask,
  sendCampaignTask,
  step,
} = await import("@hogsend/engine");
const { templates } = await import("../emails/index.js");
// The real app's `product-updates` list — wired so the marketing template's
// `product-updates` category resolves to a defined list (the container
// boot-guard rejects an unknown template category).
const { productUpdates } = await import("../lists/index.js");

// `sendCampaignTask.fn` is the real wave-runtime body (the config-preserving
// mock kept it). It self-bootstraps db from process.env.DATABASE_URL and reads
// the engine email-service + list-registry singletons — both installed by the
// file-level `createHogsendClient` below.
const campaignTask = sendCampaignTask as unknown as {
  fn: (input: { campaignId: string }) => Promise<{
    status: string;
    skipped?: boolean;
    reason?: string;
    currentStep?: number;
    nextStepAt?: string;
    totalRecipients?: number;
    sentCount?: number;
    skippedCount?: number;
    failedCount?: number;
  }>;
};
const reaperTask = reapStuckCampaignsTask as unknown as {
  fn: () => Promise<{ failed: number; reEnqueued: number; promoted: number }>;
};

// A fake provider so the engine-owned tracked mailer runs its FULL pipeline
// (idempotency lookup → preference check → email_sends insert → status
// "sent") with NO network call. The spy is the ground truth for "who actually
// reached the provider" — the wave-runtime idempotency assertions hang off it.
const providerSend = vi.fn(async (_opts: SendEmailOptions) => ({
  id: "fake-provider-id",
}));
const fakeProvider: EmailProvider = {
  send: providerSend,
  sendBatch: vi.fn(async () => ({ results: [] })),
  verifyWebhook: vi.fn(() => {
    throw new Error("not used");
  }),
  parseWebhook: vi.fn(() => {
    throw new Error("not used");
  }),
};

// Run-unique namespace: every list id / email / userId this file creates is
// prefixed, and cleanup deletes ONLY rows tracked by id/key below — a bare
// `campaign:%` sweep would nuke every campaign's send history in a shared dev
// database (see b470f07).
const RUN = `cw-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// One opt-in (defaultOptIn:false) list PER test group: the opt-in resolver
// scans email_preferences for an explicit `categories[listId] === true`, so
// separate lists keep each group's wave-0 audience isolated from members other
// groups seed mid-file (the anchoring test deliberately adds a member between
// waves).
const LIST_ANCHOR = `${RUN}-anchor`;
const LIST_QUAL = `${RUN}-qual`;
const LIST_SUP = `${RUN}-sup`;
const LIST_ERASE = `${RUN}-erase`;
const LIST_RETRY = `${RUN}-retry`;
const LIST_CANCEL = `${RUN}-cancel`;
const LIST_LEGACY = `${RUN}-legacy`;
const runList = (id: string) =>
  defineList({ id, name: id, defaultOptIn: false });

// `createHogsendClient` installs the process singletons the task body reads
// (`setEmailService`, `buildListRegistry`). The fake provider keeps the send
// pipeline offline. No app/routes here — this file tests the runtime +
// validation invariants only (serializer/response additions are owned and
// asserted elsewhere).
const container = createHogsendClient({
  email: { provider: fakeProvider, templates },
  lists: [
    runList(LIST_ANCHOR),
    runList(LIST_QUAL),
    runList(LIST_SUP),
    runList(LIST_ERASE),
    runList(LIST_RETRY),
    runList(LIST_CANCEL),
    runList(LIST_LEGACY),
    productUpdates,
  ],
});
const { db } = container;

// Cleanup ledgers — every row this file creates is tracked here by id/email.
const trackedCampaignIds: string[] = [];
const seededEmails: string[] = [];
const seededEventIds: string[] = [];
const seededContactIds: string[] = [];

interface Member {
  userId: string;
  email: string;
}

/** Seed one opt-in list member (an explicit `categories[listId] = true`). */
async function seedMember(listId: string, tag: string): Promise<Member> {
  const userId = `${RUN}-${tag}`;
  const email = `${userId}@example.com`;
  await db.insert(emailPreferences).values({
    userId,
    email,
    categories: { [listId]: true },
    unsubscribedAll: false,
    suppressed: false,
  });
  seededEmails.push(email);
  return { userId, email };
}

/**
 * Insert a multi-step campaign row the way the reconciler/route would: steps
 * blob `{ v: 1, steps }`, top-level templateKey/props mirroring the first send
 * step, status `queued`. Steps are built with the REAL `step.send`/`step.wait`
 * sugar so the stored blob is the actual authored data form.
 */
async function seedWaveCampaign(opts: {
  name: string;
  listId: string;
  steps: CampaignStep[];
}): Promise<string> {
  const first = opts.steps[0] as CampaignSendStep;
  const [row] = await db
    .insert(campaigns)
    .values({
      name: opts.name,
      status: "queued",
      audienceKind: "list",
      audienceId: opts.listId,
      templateKey: first.template,
      props: first.props ?? {},
      steps: {
        v: 1,
        steps: opts.steps as unknown as Array<Record<string, unknown>>,
      },
    })
    .returning({ id: campaigns.id });
  const id = row?.id;
  if (!id) throw new Error("failed to seed wave campaign");
  trackedCampaignIds.push(id);
  return id;
}

/** Insert a legacy (NULL steps) single-send campaign row. */
async function seedLegacyCampaign(opts: {
  name: string;
  listId: string;
}): Promise<string> {
  const [row] = await db
    .insert(campaigns)
    .values({
      name: opts.name,
      status: "queued",
      audienceKind: "list",
      audienceId: opts.listId,
      templateKey: "welcome",
      props: { name: "Ada" },
    })
    .returning({ id: campaigns.id });
  const id = row?.id;
  if (!id) throw new Error("failed to seed legacy campaign");
  trackedCampaignIds.push(id);
  return id;
}

/** The campaign row, freshly read. */
async function getRow(campaignId: string) {
  const [row] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId));
  if (!row) throw new Error(`campaign ${campaignId} vanished`);
  return row;
}

/**
 * Drive a `waiting` campaign as if its wait had elapsed: force `nextStepAt`
 * into the past (past the early-fire tolerance) and re-run the task — the
 * deterministic stand-in for the punctual scheduled run / reaper promotion.
 */
async function resumeWaiting(campaignId: string) {
  await db
    .update(campaigns)
    .set({ nextStepAt: new Date(Date.now() - 1000) })
    .where(eq(campaigns.id, campaignId));
  return campaignTask.fn({ campaignId });
}

/** email_sends rows for one STEP of a multi-step campaign (step-scoped key). */
async function stepSends(campaignId: string, stepIndex: number) {
  return db
    .select()
    .from(emailSends)
    .where(
      like(emailSends.idempotencyKey, `campaign:${campaignId}:${stepIndex}:%`),
    );
}

/** All email_sends rows attributed to a campaign (both key formats). */
async function allSends(campaignId: string) {
  return db
    .select()
    .from(emailSends)
    .where(like(emailSends.idempotencyKey, `campaign:${campaignId}:%`));
}

/** The `to` addresses that actually reached the fake provider since a clear. */
function providerRecipients(): string[] {
  // SendEmailOptions.to is string | string[]; campaign sends are always a
  // single address, but flatten so the helper's type holds regardless.
  return providerSend.mock.calls.flatMap((c) => {
    const to = (c[0] as SendEmailOptions).to;
    return Array.isArray(to) ? to : [to];
  });
}

// Shared members, seeded once. The anchoring test adds its late joiner (A3)
// mid-test; the suppression test flips SU2's unsubscribedAll mid-test — both
// scoped to their own list so no other group's wave-0 audience shifts.
let A1: Member;
let A2: Member;
let QA: Member;
let QB: Member;
let SU1: Member;
let SU2: Member;
let E1: Member;
let E2: Member;
let R1: Member;
let R2: Member;
let C1: Member;
let L1: Member;

beforeAll(async () => {
  [A1, A2] = await Promise.all([
    seedMember(LIST_ANCHOR, "a1"),
    seedMember(LIST_ANCHOR, "a2"),
  ]);
  [QA, QB] = await Promise.all([
    seedMember(LIST_QUAL, "qa"),
    seedMember(LIST_QUAL, "qb"),
  ]);
  [SU1, SU2] = await Promise.all([
    seedMember(LIST_SUP, "su1"),
    seedMember(LIST_SUP, "su2"),
  ]);
  [E1, E2] = await Promise.all([
    seedMember(LIST_ERASE, "e1"),
    seedMember(LIST_ERASE, "e2"),
  ]);
  // E2 additionally gets a live `contacts` row bound to the same externalId —
  // the erasure test soft-deletes it between waves.
  const [e2Contact] = await db
    .insert(contacts)
    .values({ externalId: E2.userId, email: E2.email })
    .returning({ id: contacts.id });
  if (e2Contact) seededContactIds.push(e2Contact.id);
  [R1, R2] = await Promise.all([
    seedMember(LIST_RETRY, "r1"),
    seedMember(LIST_RETRY, "r2"),
  ]);
  C1 = await seedMember(LIST_CANCEL, "c1");
  L1 = await seedMember(LIST_LEGACY, "l1");
});

afterAll(async () => {
  // Scoped strictly to rows THIS FILE created, by tracked ids/keys — never a
  // bare `campaign:%` sweep (shared dev DB; see b470f07).
  for (const id of trackedCampaignIds) {
    await db
      .delete(emailSends)
      .where(like(emailSends.idempotencyKey, `campaign:${id}:%`));
    await db
      .delete(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, id));
  }
  if (seededEventIds.length > 0) {
    await db.delete(userEvents).where(inArray(userEvents.id, seededEventIds));
  }
  for (const email of seededEmails) {
    await db.delete(emailSends).where(eq(emailSends.toEmail, email));
    await db.delete(emailPreferences).where(eq(emailPreferences.email, email));
  }
  if (trackedCampaignIds.length > 0) {
    await db.delete(campaigns).where(inArray(campaigns.id, trackedCampaignIds));
  }
  if (seededContactIds.length > 0) {
    await db.delete(contacts).where(inArray(contacts.id, seededContactIds));
  }
});

// A far-future instant for validation-only definitions (defineCampaign does
// not check future-ness — that's the reconciler's deploy-time question).
const FUTURE = "2999-01-01T00:00:00.000Z";

// ===========================================================================
// (1) defineCampaign steps validation matrix
// ===========================================================================

describe("defineCampaign steps validation", () => {
  it("legacy single-template form still works and compiles to one send step", () => {
    const campaign = defineCampaign({
      id: "legacy-form",
      audience: { list: "broadcast" },
      sendAt: FUTURE,
      template: "welcome",
      props: { name: "Ada" },
      subject: "Hi",
    });
    expect(campaign.meta.steps).toEqual([
      {
        kind: "send",
        template: "welcome",
        props: { name: "Ada" },
        subject: "Hi",
      },
    ]);
    // The mirrored top-level fields stay populated for single-send consumers.
    expect(campaign.meta.template).toBe("welcome");
    expect(campaign.meta.subject).toBe("Hi");
  });

  it("throws when BOTH template and steps are provided", () => {
    expect(() =>
      defineCampaign({
        id: "both-forms",
        audience: { list: "broadcast" },
        sendAt: FUTURE,
        template: "welcome",
        steps: [step.send({ template: "welcome" })],
      } as unknown as Parameters<typeof defineCampaign>[0]),
    ).toThrow(/not both/);
  });

  it("throws when NEITHER template nor steps is provided", () => {
    expect(() =>
      defineCampaign({
        id: "neither-form",
        audience: { list: "broadcast" },
        sendAt: FUTURE,
      } as unknown as Parameters<typeof defineCampaign>[0]),
    ).toThrow(/template .*or a steps array/);
  });

  it("throws on an empty steps array", () => {
    expect(() =>
      defineCampaign({
        id: "empty-steps",
        audience: { list: "broadcast" },
        sendAt: FUTURE,
        steps: [],
      }),
    ).toThrow(/steps must contain/);
  });

  it("throws when the first step is a wait", () => {
    expect(() =>
      defineCampaign({
        id: "leading-wait",
        audience: { list: "broadcast" },
        sendAt: FUTURE,
        steps: [step.wait(days(1)), step.send({ template: "welcome" })],
      }),
    ).toThrow(/first step must be a send/);
  });

  it("throws on a trailing wait", () => {
    expect(() =>
      defineCampaign({
        id: "trailing-wait",
        audience: { list: "broadcast" },
        sendAt: FUTURE,
        steps: [step.send({ template: "welcome" }), step.wait(days(1))],
      }),
    ).toThrow(/last step must not be a wait/);
  });

  it("throws when `where` appears on the FIRST send step", () => {
    expect(() =>
      defineCampaign({
        id: "where-first",
        audience: { list: "broadcast" },
        sendAt: FUTURE,
        steps: [
          step.send({ template: "welcome", where: (c) => c.notOpened() }),
        ],
      }),
    ).toThrow(/not allowed on the first step/);
  });

  it("throws on a wait shorter than 5 minutes", () => {
    expect(() =>
      defineCampaign({
        id: "tiny-wait",
        audience: { list: "broadcast" },
        sendAt: FUTURE,
        steps: [
          step.send({ template: "welcome" }),
          step.wait(minutes(4)),
          step.send({ template: "welcome" }),
        ],
      }),
    ).toThrow(/shorter than 5 minutes/);
  });

  it("throws on more than 10 steps", () => {
    const eleven = Array.from({ length: 11 }, () =>
      step.send({ template: "welcome" }),
    );
    expect(() =>
      defineCampaign({
        id: "too-many-steps",
        audience: { list: "broadcast" },
        sendAt: FUTURE,
        steps: eleven,
      }),
    ).toThrow(/got 11/);
  });

  it('rejects linked("telegram") — only "discord" has a linked-identity source in v1', () => {
    expect(() =>
      defineCampaign({
        id: "telegram-linked",
        audience: { list: "broadcast" },
        sendAt: FUTURE,
        steps: [
          step.send({ template: "welcome" }),
          step.send({
            template: "welcome",
            where: (c) => c.linked("telegram"),
          }),
        ],
      }),
    ).toThrow(/only "discord"/);
  });

  it('rejects declarative "property" and "composite" conditions — the wave runtime cannot compile them', () => {
    // CampaignWhere accepts raw declarative ConditionEval, so these are
    // typed-legal; without the define-time check they would throw mid-campaign
    // at wave k — a poison wave instead of a deploy-time error.
    expect(() =>
      defineCampaign({
        id: "property-where",
        audience: { list: "broadcast" },
        sendAt: FUTURE,
        steps: [
          step.send({ template: "welcome" }),
          step.send({
            template: "welcome",
            where: [
              {
                type: "property",
                property: "plan",
                operator: "eq",
                value: "pro",
              },
            ],
          }),
        ],
      }),
    ).toThrow(/does not support "property"/);

    expect(() =>
      defineCampaign({
        id: "composite-where",
        audience: { list: "broadcast" },
        sendAt: FUTURE,
        steps: [
          step.send({ template: "welcome" }),
          step.send({
            template: "welcome",
            where: [
              {
                type: "composite",
                operator: "or",
                conditions: [{ type: "email_engagement", check: "opened" }],
              },
            ],
          }),
        ],
      }),
    ).toThrow(/does not support "composite"/);
  });

  it('rejects event "count" checks — only exists/not_exists compile to wave SQL', () => {
    expect(() =>
      defineCampaign({
        id: "count-where",
        audience: { list: "broadcast" },
        sendAt: FUTURE,
        steps: [
          step.send({ template: "welcome" }),
          step.send({
            template: "welcome",
            where: [
              {
                type: "event",
                eventName: "page.viewed",
                check: "count",
                operator: "gte",
                value: 3,
              },
            ],
          }),
        ],
      }),
    ).toThrow(/"count" checks/);
  });

  it("`where` on a later send step normalizes the builder to plain condition data", () => {
    const campaign = defineCampaign({
      id: "with-where",
      audience: { list: "broadcast" },
      sendAt: FUTURE,
      steps: [
        step.send({ template: "welcome" }),
        step.wait(days(2)),
        step.send({
          template: "welcome",
          where: (c) => [
            c.opened("welcome"),
            c.notClicked(),
            c.firedEvent("account.created"),
            c.notLinked("discord"),
          ],
        }),
      ],
    });

    // The stored form is byte-identical POJOs — the exact ConditionEval data
    // the wave runtime compiles to SQL. `notClicked()` with no template means
    // "any prior send of THIS campaign" (templateKey absent, not undefined).
    const where = (campaign.meta.steps[2] as CampaignSendStep).where;
    expect(where).toEqual([
      { type: "email_engagement", check: "opened", templateKey: "welcome" },
      { type: "email_engagement", check: "not_clicked" },
      { type: "event", eventName: "account.created", check: "exists" },
      { type: "channel_identity", connector: "discord", check: "not_linked" },
    ]);
    expect(where?.[1]).not.toHaveProperty("templateKey");
  });
});

// ===========================================================================
// (3)+(6) Cohort anchoring + the waiting lifecycle. One 3-step campaign
// (send, wait 2d, send) driven wave by wave: the cohort is anchored at wave 0
// (a member subscribed AFTER wave 0 never receives anything), the row parks
// `waiting` with the exact cursor/instant/counts, and startedAt survives the
// resume claim.
// ===========================================================================

describe("cohort anchoring + waiting lifecycle (3-step campaign)", () => {
  it("anchors the cohort at wave 0, parks waiting, and resumes to ONLY the anchored cohort", async () => {
    const campaignId = await seedWaveCampaign({
      name: "Anchored waves",
      listId: LIST_ANCHOR,
      steps: [
        step.send({ template: "welcome", props: { name: "Ada" } }),
        step.wait(days(2)),
        step.send({ template: "welcome", props: { name: "Ada" } }),
      ],
    });

    // --- Wave 0 ---
    providerSend.mockClear();
    scheduleSpy.mockClear();
    const waveStart = Date.now();
    const result = await campaignTask.fn({ campaignId });

    // Parked at the wait: cursor points at the wait's SUCCESSOR (k+1 = 2).
    expect(result.status).toBe("waiting");
    expect(result.currentStep).toBe(2);

    // Both members reached the provider with STEP-SCOPED keys (step 0 — a
    // multi-step campaign uses `campaign:<id>:<step>:<email>` for ALL steps).
    expect(providerRecipients().sort()).toEqual([A1.email, A2.email].sort());
    const wave0 = await stepSends(campaignId, 0);
    expect(wave0).toHaveLength(2);
    expect(wave0.map((s) => s.idempotencyKey).sort()).toEqual(
      [
        `campaign:${campaignId}:0:${A1.email}`,
        `campaign:${campaignId}:0:${A2.email}`,
      ].sort(),
    );

    // The cohort ledger: one row per (campaign, member), normalized emails +
    // the resolver's userId.
    const cohort = await db
      .select()
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaignId));
    expect(cohort).toHaveLength(2);
    expect(cohort.map((r) => r.email).sort()).toEqual(
      [A1.email, A2.email].sort(),
    );
    expect(cohort.map((r) => r.userId).sort()).toEqual(
      [A1.userId, A2.userId].sort(),
    );

    // The parked row: waiting, cursor 2, nextStepAt ≈ now + 2 days, cumulative
    // counts persisted AND snapshotted as the resume seed, startedAt claimed.
    const parked = await getRow(campaignId);
    expect(parked.status).toBe("waiting");
    expect(parked.currentStep).toBe(2);
    expect(parked.nextStepAt).not.toBeNull();
    const expectedResume = waveStart + 48 * 3_600_000;
    expect(
      Math.abs((parked.nextStepAt?.getTime() ?? 0) - expectedResume),
    ).toBeLessThan(60_000);
    expect(parked.totalRecipients).toBe(2);
    expect(parked.sentCount).toBe(2);
    expect(parked.skippedCount).toBe(0);
    expect(parked.failedCount).toBe(0);
    expect(parked.stepBaseCounts).toEqual({
      total: 2,
      sent: 2,
      skipped: 0,
      failed: 0,
    });
    expect(parked.startedAt).not.toBeNull();
    const startedAt = parked.startedAt?.getTime();

    // The punctual next-step run was scheduled at nextStepAt.
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    const [at, input] = scheduleSpy.mock.calls[0] ?? [];
    expect((at as Date).getTime()).toBe(parked.nextStepAt?.getTime());
    expect((input as { campaignId: string }).campaignId).toBe(campaignId);

    // --- Stale punctual run while the wait is still pending: early-fire
    // guard skips without sending or mutating the row. ---
    providerSend.mockClear();
    const early = await campaignTask.fn({ campaignId });
    expect(early.status).toBe("waiting");
    expect(early.skipped).toBe(true);
    expect(providerSend).not.toHaveBeenCalled();
    expect((await getRow(campaignId)).status).toBe("waiting");

    // --- A NEW member subscribes to the list AFTER wave 0. The cohort was
    // anchored — they must receive NOTHING from this campaign. ---
    const A3 = await seedMember(LIST_ANCHOR, "a3-late");

    // --- Resume (wait elapsed) ---
    providerSend.mockClear();
    const final = await resumeWaiting(campaignId);
    expect(final.status).toBe("sent");

    // Step 2 went to the ORIGINAL cohort only, with step-2 keys.
    expect(providerRecipients().sort()).toEqual([A1.email, A2.email].sort());
    const wave2 = await stepSends(campaignId, 2);
    expect(wave2).toHaveLength(2);
    expect(wave2.map((s) => s.idempotencyKey).sort()).toEqual(
      [
        `campaign:${campaignId}:2:${A1.email}`,
        `campaign:${campaignId}:2:${A2.email}`,
      ].sort(),
    );

    // The late joiner: no cohort row, no sends — for THIS campaign or at all.
    const lateCohort = await db
      .select()
      .from(campaignRecipients)
      .where(
        and(
          eq(campaignRecipients.campaignId, campaignId),
          eq(campaignRecipients.email, A3.email),
        ),
      );
    expect(lateCohort).toHaveLength(0);
    const lateSends = await db
      .select()
      .from(emailSends)
      .where(eq(emailSends.toEmail, A3.email));
    expect(lateSends).toHaveLength(0);

    // Terminal row: cumulative counts across waves; the pending-wait fields
    // are nulled; startedAt is PRESERVED across the resume claim (coalesce —
    // event conditions scope to it, so the resume must never reset it).
    const done = await getRow(campaignId);
    expect(done.status).toBe("sent");
    expect(done.totalRecipients).toBe(4);
    expect(done.sentCount).toBe(4);
    expect(done.skippedCount).toBe(0);
    expect(done.failedCount).toBe(0);
    expect(done.completedAt).not.toBeNull();
    expect(done.nextStepAt).toBeNull();
    expect(done.stepBaseCounts).toBeNull();
    expect(done.startedAt?.getTime()).toBe(startedAt);
  });
});

// ===========================================================================
// (4) Qualifier conditions: seeded engagement (openedAt/clickedAt on wave-0
// rows) + user_events filter the wave-2 recipient set EXACTLY.
// ===========================================================================

describe("wave qualifier conditions", () => {
  /**
   * Drive one (send, wait, send-with-where) campaign over LIST_QUAL to its
   * wait, run `engage` between the waves, resume, and return the step-2
   * provider recipients. Engagement rows/events are keyed per campaign, so the
   * four campaigns sharing the list never cross-talk.
   */
  async function runQualifierCampaign(opts: {
    name: string;
    where: CampaignSendStep["where"];
    engage: (campaignId: string) => Promise<void>;
  }): Promise<string[]> {
    const sendStep = step.send({ template: "welcome", props: { name: "Ada" } });
    const campaignId = await seedWaveCampaign({
      name: opts.name,
      listId: LIST_QUAL,
      steps: [sendStep, step.wait(days(2)), { ...sendStep, where: opts.where }],
    });

    const wave0 = await campaignTask.fn({ campaignId });
    expect(wave0.status).toBe("waiting");

    await opts.engage(campaignId);

    providerSend.mockClear();
    const final = await resumeWaiting(campaignId);
    expect(final.status).toBe("sent");
    return providerRecipients().sort();
  }

  /** Stamp engagement on ONE member's wave-0 send row. */
  async function stampWave0(
    campaignId: string,
    email: string,
    fields: { openedAt?: Date; clickedAt?: Date },
  ) {
    await db
      .update(emailSends)
      .set(fields)
      .where(
        eq(emailSends.idempotencyKey, `campaign:${campaignId}:0:${email}`),
      );
  }

  /** Insert a user_events row (tracked for cleanup). */
  async function fireEvent(userId: string, event: string) {
    const [row] = await db
      .insert(userEvents)
      .values({ userId, event, occurredAt: new Date() })
      .returning({ id: userEvents.id });
    if (row) seededEventIds.push(row.id);
  }

  it("notOpened() excludes the member whose wave-0 send was opened", async () => {
    const recipients = await runQualifierCampaign({
      name: "Qualifier notOpened",
      where: [{ type: "email_engagement", check: "not_opened" }],
      engage: (id) => stampWave0(id, QA.email, { openedAt: new Date() }),
    });
    expect(recipients).toEqual([QB.email]);
  });

  it("notClicked() excludes the member whose wave-0 send was clicked", async () => {
    const recipients = await runQualifierCampaign({
      name: "Qualifier notClicked",
      where: [{ type: "email_engagement", check: "not_clicked" }],
      engage: (id) => stampWave0(id, QA.email, { clickedAt: new Date() }),
    });
    expect(recipients).toEqual([QB.email]);
  });

  it("firedEvent() selects ONLY the member who fired the event since startedAt", async () => {
    const EVENT = `${RUN}.q3.converted`;
    const recipients = await runQualifierCampaign({
      name: "Qualifier firedEvent",
      where: [{ type: "event", eventName: EVENT, check: "exists" }],
      engage: () => fireEvent(QA.userId, EVENT),
    });
    expect(recipients).toEqual([QA.email]);
  });

  it("notFiredEvent() excludes the member who fired the event", async () => {
    const EVENT = `${RUN}.q4.converted`;
    const recipients = await runQualifierCampaign({
      name: "Qualifier notFiredEvent",
      where: [{ type: "event", eventName: EVENT, check: "not_exists" }],
      engage: () => fireEvent(QA.userId, EVENT),
    });
    expect(recipients).toEqual([QB.email]);
  });
});

// ===========================================================================
// (5) Suppression re-check between waves: suppression is never snapshotted —
// a member who unsubscribes between waves is excluded from every later wave.
// ===========================================================================

describe("between-wave suppression re-check", () => {
  it("a cohort member who unsubscribedAll between waves receives no later wave", async () => {
    const campaignId = await seedWaveCampaign({
      name: "Suppression re-check",
      listId: LIST_SUP,
      steps: [
        step.send({ template: "welcome", props: { name: "Ada" } }),
        step.wait(days(2)),
        step.send({ template: "welcome", props: { name: "Ada" } }),
      ],
    });

    providerSend.mockClear();
    const wave0 = await campaignTask.fn({ campaignId });
    expect(wave0.status).toBe("waiting");
    expect(providerRecipients().sort()).toEqual([SU1.email, SU2.email].sort());

    // SU2 globally unsubscribes mid-wait. Still a cohort member — but the
    // wave-k resolver re-checks suppression fresh (GDPR/CAN-SPAM).
    await db
      .update(emailPreferences)
      .set({ unsubscribedAll: true })
      .where(eq(emailPreferences.email, SU2.email));

    providerSend.mockClear();
    const final = await resumeWaiting(campaignId);
    expect(final.status).toBe("sent");
    expect(providerRecipients()).toEqual([SU1.email]);

    // Excluded at the resolver — SU2 has no step-2 row at all (not even a
    // skipped one), while their cohort membership row remains.
    const wave2 = await stepSends(campaignId, 2);
    expect(wave2).toHaveLength(1);
    expect(wave2[0]?.toEmail).toBe(SU1.email);
    const cohort = await db
      .select()
      .from(campaignRecipients)
      .where(
        and(
          eq(campaignRecipients.campaignId, campaignId),
          eq(campaignRecipients.email, SU2.email),
        ),
      );
    expect(cohort).toHaveLength(1);
  });
});

// ===========================================================================
// (5b) Erasure re-check: an admin contact delete (GDPR) sets ONLY
// contacts.deletedAt — email_preferences is untouched, so the prefs re-check
// alone would still qualify the member. The cohort resolver's erased-contact
// NOT EXISTS must exclude them from every later wave.
// ===========================================================================

describe("between-wave contact erasure re-check", () => {
  it("a cohort member whose contact was soft-deleted between waves receives no later wave", async () => {
    const campaignId = await seedWaveCampaign({
      name: "Erasure re-check",
      listId: LIST_ERASE,
      steps: [
        step.send({ template: "welcome", props: { name: "Ada" } }),
        step.wait(days(2)),
        step.send({ template: "welcome", props: { name: "Ada" } }),
      ],
    });

    providerSend.mockClear();
    const wave0 = await campaignTask.fn({ campaignId });
    expect(wave0.status).toBe("waiting");
    expect(providerRecipients().sort()).toEqual([E1.email, E2.email].sort());

    // E2 is erased mid-wait.
    await db
      .update(contacts)
      .set({ deletedAt: new Date() })
      .where(eq(contacts.externalId, E2.userId));

    providerSend.mockClear();
    const final = await resumeWaiting(campaignId);
    expect(final.status).toBe("sent");
    expect(providerRecipients()).toEqual([E1.email]);

    // Excluded at the resolver — no step-2 row at all for E2.
    const wave2 = await stepSends(campaignId, 2);
    expect(wave2).toHaveLength(1);
    expect(wave2[0]?.toEmail).toBe(E1.email);
  });
});

// ===========================================================================
// (7) Retry safety: a replayed wave (crash-then-retry) dispatches no duplicate
// provider sends and does not double-count (stepBaseCounts seeding).
// ===========================================================================

describe("wave retry safety", () => {
  it("re-running a mid-flight wave no-ops dispatched sends and re-tallies exactly", async () => {
    const campaignId = await seedWaveCampaign({
      name: "Retryable waves",
      listId: LIST_RETRY,
      steps: [
        step.send({ template: "welcome", props: { name: "Ada" } }),
        step.wait(days(2)),
        step.send({ template: "welcome", props: { name: "Ada" } }),
      ],
    });

    // Wave 0 completes and parks.
    providerSend.mockClear();
    const first = await campaignTask.fn({ campaignId });
    expect(first.status).toBe("waiting");
    expect(providerRecipients().sort()).toEqual([R1.email, R2.email].sort());
    const wave0Rows = await stepSends(campaignId, 0);
    expect(wave0Rows).toHaveLength(2);

    // Simulate the crash-shaped state a Hatchet retry re-enters: the wave was
    // fully dispatched but the park never landed — status still `sending`,
    // cursor still at the interrupted wave, no snapshot seed yet.
    await db
      .update(campaigns)
      .set({
        status: "sending",
        currentStep: 0,
        stepBaseCounts: null,
        nextStepAt: null,
      })
      .where(eq(campaigns.id, campaignId));

    providerSend.mockClear();
    const retry = await campaignTask.fn({ campaignId });
    expect(retry.status).toBe("waiting");
    expect(retry.currentStep).toBe(2);

    // Every send short-circuited to its prior email_sends row — the provider
    // was never called again, and no duplicate rows were inserted.
    expect(providerSend).not.toHaveBeenCalled();
    const wave0After = await stepSends(campaignId, 0);
    expect(wave0After).toHaveLength(2);
    expect(wave0After.map((r) => r.id).sort()).toEqual(
      wave0Rows.map((r) => r.id).sort(),
    );

    // Counts re-derived from scratch on top of the (null → zero) seed — NOT
    // doubled: the idempotency-aware send() returned the prior "sent" status.
    const parked = await getRow(campaignId);
    expect(parked.totalRecipients).toBe(2);
    expect(parked.sentCount).toBe(2);
    expect(parked.stepBaseCounts).toEqual({
      total: 2,
      sent: 2,
      skipped: 0,
      failed: 0,
    });

    // Finish the campaign, then re-drive it: the terminal guard no-ops.
    const final = await resumeWaiting(campaignId);
    expect(final.status).toBe("sent");
    expect((await stepSends(campaignId, 2)).length).toBe(2);

    providerSend.mockClear();
    const redrive = await campaignTask.fn({ campaignId });
    expect(redrive.status).toBe("sent");
    expect(redrive.skipped).toBe(true);
    expect(providerSend).not.toHaveBeenCalled();
    const done = await getRow(campaignId);
    expect(done.totalRecipients).toBe(4);
    expect(done.sentCount).toBe(4);
  });
});

// ===========================================================================
// (8) Cancel from waiting: `waiting` is non-terminal and cancelable; the
// pending punctual run then no-ops on the terminal guard.
// ===========================================================================

describe("cancel from waiting", () => {
  it("cancels a waiting campaign; the pending resume run no-ops", async () => {
    const campaignId = await seedWaveCampaign({
      name: "Cancel while waiting",
      listId: LIST_CANCEL,
      steps: [
        step.send({ template: "welcome", props: { name: "Ada" } }),
        step.wait(days(2)),
        step.send({ template: "welcome", props: { name: "Ada" } }),
      ],
    });

    providerSend.mockClear();
    const wave0 = await campaignTask.fn({ campaignId });
    expect(wave0.status).toBe("waiting");
    expect(providerRecipients()).toEqual([C1.email]);

    // The cancel CAS the route performs (waiting is in the allowed set) —
    // asserted here as the direct status transition so this file stays off
    // the route surface.
    const canceled = await db
      .update(campaigns)
      .set({
        status: "canceled",
        canceledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.status, "waiting")))
      .returning({ id: campaigns.id });
    expect(canceled).toHaveLength(1);

    // The punctual next-step run still fires later — terminal guard no-ops it
    // even with the wait elapsed.
    providerSend.mockClear();
    const resumed = await resumeWaiting(campaignId);
    expect(resumed.status).toBe("canceled");
    expect(resumed.skipped).toBe(true);
    expect(providerSend).not.toHaveBeenCalled();
    expect((await stepSends(campaignId, 2)).length).toBe(0);
    expect((await getRow(campaignId)).status).toBe("canceled");
  });
});

// ===========================================================================
// (9) Reaper `waiting` sweeps: promote past the grace, give up past the
// window (both measured from nextStepAt), and leave a mid-wait row alone —
// `waiting` is NOT subject to the stale-`sending` re-enqueue.
// ===========================================================================

describe("reapStuckCampaignsTask (waiting sweeps)", () => {
  async function seedWaitingRow(opts: {
    name: string;
    nextStepAt: Date;
  }): Promise<string> {
    const [row] = await db
      .insert(campaigns)
      .values({
        name: opts.name,
        status: "waiting",
        audienceKind: "list",
        audienceId: LIST_LEGACY,
        templateKey: "welcome",
        currentStep: 2,
        nextStepAt: opts.nextStepAt,
        steps: {
          v: 1,
          steps: [
            step.send({ template: "welcome" }),
            step.wait(days(2)),
            step.send({ template: "welcome" }),
          ] as unknown as Array<Record<string, unknown>>,
        },
      })
      .returning({ id: campaigns.id });
    const id = row?.id;
    if (!id) throw new Error("failed to seed waiting row");
    trackedCampaignIds.push(id);
    return id;
  }

  it("promotes a past-grace waiting row, fails one past the give-up window, leaves a mid-wait row alone", async () => {
    const promoteId = await seedWaitingRow({
      name: "Waiting, punctual run lost",
      nextStepAt: new Date(Date.now() - 10 * 60 * 1000), // 10 min past grace
    });
    const giveUpId = await seedWaitingRow({
      name: "Waiting, stuck past give-up",
      nextStepAt: new Date(Date.now() - 7 * 60 * 60 * 1000), // 7h past
    });
    const midWaitId = await seedWaitingRow({
      name: "Waiting, legitimately mid-wait",
      nextStepAt: new Date(Date.now() + 60 * 60 * 1000), // 1h future
    });
    // Backdate the mid-wait row's updatedAt past the stale-`sending` window:
    // if `waiting` were wrongly included in the stale re-enqueue sweep, THIS
    // row would be re-driven mid-wait.
    await db
      .update(campaigns)
      .set({ updatedAt: new Date(Date.now() - 30 * 60 * 1000) })
      .where(eq(campaigns.id, midWaitId));

    runNoWaitSpy.mockClear();
    await reaperTask.fn();

    const enqueued = runNoWaitSpy.mock.calls.map(
      (call) => (call[0] as { campaignId: string }).campaignId,
    );

    // Promoted: enqueue-only — the row stays `waiting` until the send task
    // claims it (mirror of the due-`scheduled` sweep).
    expect(enqueued).toContain(promoteId);
    expect((await getRow(promoteId)).status).toBe("waiting");

    // Give-up: failed (measured from nextStepAt, NOT updatedAt — the insert
    // just now made updatedAt fresh), and NOT re-enqueued.
    const giveUpRow = await getRow(giveUpId);
    expect(giveUpRow.status).toBe("failed");
    expect(giveUpRow.completedAt).not.toBeNull();
    expect(enqueued).not.toContain(giveUpId);

    // Mid-wait: untouched despite the stale updatedAt — a 2-day wait is not a
    // stuck campaign.
    expect(enqueued).not.toContain(midWaitId);
    expect((await getRow(midWaitId)).status).toBe("waiting");
  });
});

// ===========================================================================
// (2)+(10) Legacy (NULL steps) regression: single blast, LEGACY key format
// (no step segment), ends `sent` — byte-identical to pre-waves behavior.
// ===========================================================================

describe("legacy single-send campaign (NULL steps)", () => {
  it("sends one blast with the legacy key and ends sent", async () => {
    const campaignId = await seedLegacyCampaign({
      name: "Legacy blast",
      listId: LIST_LEGACY,
    });

    providerSend.mockClear();
    scheduleSpy.mockClear();
    const result = await campaignTask.fn({ campaignId });
    expect(result.status).toBe("sent");
    expect(providerRecipients()).toEqual([L1.email]);

    // The LEGACY key — `campaign:<id>:<email>`, no step segment. A single-
    // step/NULL-steps campaign NEVER uses step-scoped keys.
    const sends = await allSends(campaignId);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.idempotencyKey).toBe(`campaign:${campaignId}:${L1.email}`);
    expect(sends[0]?.status).toBe("sent");

    // One shot, straight to terminal: no park, no punctual next-step run, no
    // pending-wait fields left behind.
    expect(scheduleSpy).not.toHaveBeenCalled();
    const row = await getRow(campaignId);
    expect(row.status).toBe("sent");
    expect(row.nextStepAt).toBeNull();
    expect(row.stepBaseCounts).toBeNull();
    expect(row.completedAt).not.toBeNull();
    expect(row.sentCount).toBe(1);
    expect(row.totalRecipients).toBe(1);
  });
});
