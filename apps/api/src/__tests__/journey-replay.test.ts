/**
 * Replay-safety proof for journey side-effects.
 *
 * Journeys run as Hatchet durable tasks that replay-from-top on a worker crash /
 * OOM / redeploy. Side effects sitting between durable waits (sendEmail,
 * ctx.trigger) must therefore be EXACTLY-ONCE across a replay.
 *
 * Two defense layers, both fed by ONE shared content/site-derived key, both
 * wired entirely inside the engine so journey authoring is unchanged:
 *   • Layer 2 (PRIMARY, version-independent) — a deterministic, branch-stable
 *     key threaded into the existing unique-index dedup paths
 *     (email_sends.idempotencyKey, user_events.idempotencyKey).
 *   • Layer 1 (FAST-PATH, eviction-gated) — the SAME key memoized via Hatchet's
 *     durable `memo`, skipping the effect entirely before the DB is touched.
 *
 * The boundary is established by `runWithJourneyBoundary` (what define-journey
 * wraps `run()` in). A replay is simulated by re-entering the boundary and
 * re-driving the SAME logical side effect against the SAME stateId.
 *
 * Mirrors the history-events.test.ts harness: one TimescaleDB instance,
 * RUN-namespaced rows, a mock Hatchet, full cleanup in afterAll.
 */

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { contacts, emailSends, journeyStates, userEvents } = await import(
  "@hogsend/db"
);
const { and, eq } = await import("drizzle-orm");
const {
  createHogsendClient,
  createJourneyContext,
  createMemoize,
  createTrackedMailer,
  deriveJourneyKey,
  runWithJourneyBoundary,
  sendEmail,
  setEmailService,
} = await import("@hogsend/engine");
type JourneyBoundary = import("@hogsend/engine").JourneyBoundary;
const { templates } = await import("../emails/index.js");
type EmailProvider = import("@hogsend/engine").EmailProvider;

// Mock Hatchet — ctx.trigger's ingestEvent pushes through events.push, which we
// stub. Each test resets the push spy so per-test call counts are clean.
const pushSpy = vi.fn().mockResolvedValue(undefined);
const mockHatchet = {
  durableTask: vi.fn(() => ({
    run: vi.fn(),
    runNoWait: vi.fn(),
    runAndWait: vi.fn(),
  })),
  task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
  events: { push: pushSpy },
  runs: { cancel: vi.fn(), get: vi.fn() },
  worker: vi.fn(),
} as unknown as ReturnType<typeof createHogsendClient>["hatchet"];

const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const { db } = container;

const RUN = `jr-${Date.now()}`;

// A mock email service capturing every send's resolved idempotencyKey. It mimics
// the unique-index dedup: a key already seen returns the prior row without a new
// "provider call" (tracked by providerCalls). An unkeyed send always dispatches
// (Postgres treats NULLs as distinct).
let sendCalls: Array<{ template: string; idempotencyKey?: string }> = [];
let providerCalls = 0;
const seenKeys = new Map<string, string>();

function installMockEmailService() {
  sendCalls = [];
  providerCalls = 0;
  seenKeys.clear();
  setEmailService({
    // biome-ignore lint/suspicious/noExplicitAny: minimal send stub
    send: vi.fn(async (options: any) => {
      const key = options.idempotencyKey as string | undefined;
      sendCalls.push({ template: options.template, idempotencyKey: key });
      if (key && seenKeys.has(key)) {
        return {
          emailSendId: seenKeys.get(key) ?? "",
          messageId: "",
          resendId: "",
          status: "sent" as const,
        };
      }
      providerCalls += 1;
      const id = `send-${providerCalls}`;
      if (key) seenKeys.set(key, id);
      return {
        emailSendId: id,
        messageId: id,
        resendId: id,
        status: "sent" as const,
      };
      // biome-ignore lint/suspicious/noExplicitAny: minimal service stub
    }) as any,
    // biome-ignore lint/suspicious/noExplicitAny: unused in these tests
  } as any);
}

/** Build a fresh journey boundary the way define-journey does. `hatchetCtx` is a
 * stub: pass `{ memo, supportsEviction }` to exercise the Layer-1 fast path. */
function makeBoundary(opts: {
  stateId: string;
  // biome-ignore lint/suspicious/noExplicitAny: minimal hatchetCtx stub
  hatchetCtx?: any;
}): JourneyBoundary {
  return {
    stateId: opts.stateId,
    // In a non-durable test ctx there is no Hatchet run id, so the anchor falls
    // back to stateId — keeping the derived keys `journeySend:<stateId>:…`.
    runAnchor: opts.stateId,
    currentLabel: undefined,
    seenKeys: new Set<string>(),
    memoize: createMemoize(opts.hatchetCtx ?? {}),
  };
}

/** Build a journey context wired to the container db + mock hatchet. */
function makeCtx(opts: {
  stateId: string;
  userId: string;
  userEmail: string;
  now?: () => Promise<Date>;
}) {
  return createJourneyContext({
    db: db as Parameters<typeof createJourneyContext>[0]["db"],
    hatchet: mockHatchet as Parameters<
      typeof createJourneyContext
    >[0]["hatchet"],
    hatchetCtx: {
      sleepFor: vi.fn() as unknown as (d: unknown) => Promise<unknown>,
      waitFor: vi.fn() as unknown as (
        c: unknown,
      ) => Promise<Record<string, unknown>>,
      ...(opts.now ? { now: opts.now } : {}),
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
    registry: { get: () => undefined } as any,
    // biome-ignore lint/suspicious/noExplicitAny: minimal logger stub
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    stateId: opts.stateId,
    userId: opts.userId,
    userEmail: opts.userEmail,
    journeyContext: {},
    resolvedTimezone: "UTC",
  });
}

beforeEach(() => {
  pushSpy.mockClear();
  installMockEmailService();
});

afterAll(async () => {
  await db.delete(userEvents).where(eq(userEvents.userId, `${RUN}-trig`));
  await db.delete(contacts).where(eq(contacts.externalId, `${RUN}-trig`));
  // Real-DB email exactly-once proof rows (keyed userId prefix `${RUN}-real`).
  await db.delete(emailSends).where(eq(emailSends.userId, `${RUN}-real-1`));
  await db.delete(emailSends).where(eq(emailSends.userId, `${RUN}-real-2`));
  await db
    .delete(journeyStates)
    .where(eq(journeyStates.userId, `${RUN}-real-1`));
  await db
    .delete(journeyStates)
    .where(eq(journeyStates.userId, `${RUN}-real-2`));
});

/** Seed a real journey_states row (email_sends.journey_state_id FK targets it). */
async function seedState(userId: string, journeyId: string): Promise<string> {
  const [row] = await db
    .insert(journeyStates)
    .values({
      userId,
      userEmail: `${userId}@example.com`,
      journeyId,
      currentNodeId: "start",
      status: "active",
    })
    .returning({ id: journeyStates.id });
  return row?.id ?? "";
}

const baseSend = (stateId: string, userId: string, template: string) => ({
  to: `${userId}@example.com`,
  userId,
  journeyStateId: stateId,
  template,
  subject: "hi",
});

describe("journey send idempotency key derivation (boundary-aware)", () => {
  it("derives a branch-stable journeySend:<stateId>:<site>:<template> key", async () => {
    const stateId = `${RUN}-s1`;
    await runWithJourneyBoundary(makeBoundary({ stateId }), () =>
      sendEmail(baseSend(stateId, `${RUN}-u1`, "welcome")),
    );
    // No preceding wait label => site falls back to the template key.
    expect(sendCalls[0]?.idempotencyKey).toBe(
      `journeySend:${stateId}:welcome:welcome`,
    );
  });

  it("re-derives the SAME key across a replay → exactly-once delivery", async () => {
    const stateId = `${RUN}-s2`;
    const args = baseSend(stateId, `${RUN}-u2`, "welcome");
    // Each replay re-enters a FRESH boundary (define-journey re-wraps run()).
    await runWithJourneyBoundary(makeBoundary({ stateId }), () =>
      sendEmail(args),
    );
    await runWithJourneyBoundary(makeBoundary({ stateId }), () =>
      sendEmail(args),
    );
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[0]?.idempotencyKey).toBe(sendCalls[1]?.idempotencyKey);
    // The unique-index short-circuit (mocked) dispatched the provider ONCE.
    expect(providerCalls).toBe(1);
  });

  it("explicit idempotencyKey overrides the auto-derived key", async () => {
    const stateId = `${RUN}-s4`;
    await runWithJourneyBoundary(makeBoundary({ stateId }), () =>
      sendEmail({
        ...baseSend(stateId, `${RUN}-u4`, "welcome"),
        idempotencyKey: "explicit-key",
      }),
    );
    expect(sendCalls[0]?.idempotencyKey).toBe("explicit-key");
  });

  it("OUTSIDE a journey (no boundary) leaves the key undefined (NULL distinct)", async () => {
    // Admin bulk / POST /v1/emails path: behavior is byte-identical to before.
    await sendEmail(baseSend(`${RUN}-s5`, `${RUN}-u5`, "welcome"));
    expect(sendCalls[0]?.idempotencyKey).toBeUndefined();
  });
});

describe("SCENARIO A — branch flip: no over/under-dedup", () => {
  it("distinct templates → distinct keys, each exactly-once", async () => {
    const stateId = `${RUN}-s3`;
    const base = { to: "a@example.com", userId: `${RUN}-u3`, subject: "hi" };
    // Original run took NUDGE; replay diverged to ADVANCED. DISTINCT templates =>
    // DISTINCT keys => each delivered once, neither a duplicate of the other.
    await runWithJourneyBoundary(makeBoundary({ stateId }), () =>
      sendEmail({ ...base, journeyStateId: stateId, template: "nudge" }),
    );
    await runWithJourneyBoundary(makeBoundary({ stateId }), () =>
      sendEmail({ ...base, journeyStateId: stateId, template: "advanced" }),
    );
    expect(sendCalls[0]?.idempotencyKey).toBe(
      `journeySend:${stateId}:nudge:nudge`,
    );
    expect(sendCalls[1]?.idempotencyKey).toBe(
      `journeySend:${stateId}:advanced:advanced`,
    );
    expect(providerCalls).toBe(2);
  });
});

describe("SCENARIO B — same template twice, disambiguated by idempotencyLabel", () => {
  it("WITHOUT a distinct label: throws the intra-run collision error (loud footgun)", async () => {
    const stateId = `${RUN}-s6`;
    await expect(
      runWithJourneyBoundary(makeBoundary({ stateId }), async () => {
        await sendEmail(baseSend(stateId, `${RUN}-u6`, "nps-survey"));
        // Same template, same (absent) label => same derived key => collision.
        await sendEmail(baseSend(stateId, `${RUN}-u6`, "nps-survey"));
      }),
    ).rejects.toThrow(/duplicate idempotency key/);
  });

  it("WITH distinct idempotencyLabel: both delivered (each exactly-once)", async () => {
    const stateId = `${RUN}-s7`;
    await runWithJourneyBoundary(makeBoundary({ stateId }), async () => {
      await sendEmail({
        ...baseSend(stateId, `${RUN}-u7`, "nps-survey"),
        idempotencyLabel: "nps-survey",
      });
      await sendEmail({
        ...baseSend(stateId, `${RUN}-u7`, "nps-survey"),
        idempotencyLabel: "nps-reminder",
      });
    });
    expect(providerCalls).toBe(2);
    expect(sendCalls[0]?.idempotencyKey).toBe(
      `journeySend:${stateId}:nps-survey:nps-survey`,
    );
    expect(sendCalls[1]?.idempotencyKey).toBe(
      `journeySend:${stateId}:nps-reminder:nps-survey`,
    );
  });
});

describe("Layer 1 — memo fast path", () => {
  it("eviction LIVE: replay returns the recorded result without re-running the effect", async () => {
    const stateId = `${RUN}-s12`;
    // A stub memo: stores by deps key, returns the recorded payload on a repeat.
    const store = new Map<string, unknown>();
    let realCalls = 0;
    const hatchetCtx = {
      supportsEviction: true,
      memo: async (fn: () => unknown, deps: unknown[]) => {
        const key = JSON.stringify(deps);
        if (store.has(key)) return store.get(key);
        realCalls += 1;
        const result = await fn();
        // Mirror the SDK's JSON round-trip (proves sentAt stays a string).
        const round = JSON.parse(JSON.stringify(result));
        store.set(key, round);
        return round;
      },
    };
    const first = await runWithJourneyBoundary(
      makeBoundary({ stateId, hatchetCtx }),
      () => sendEmail(baseSend(stateId, `${RUN}-u12`, "welcome")),
    );
    const second = await runWithJourneyBoundary(
      makeBoundary({ stateId, hatchetCtx }),
      () => sendEmail(baseSend(stateId, `${RUN}-u12`, "welcome")),
    );
    // The real effect ran ONCE; the replay returned the memoized result verbatim.
    expect(realCalls).toBe(1);
    expect(second.emailSendId).toBe(first.emailSendId);
    expect(typeof second.sentAt).toBe("string");
    expect(second.sentAt).toBe(first.sentAt);
  });

  it("eviction OFF: memoize falls through to fn() (Layer 2 still guards)", async () => {
    const stateId = `${RUN}-s13`;
    const hatchetCtx = { supportsEviction: false, memo: vi.fn() };
    await runWithJourneyBoundary(makeBoundary({ stateId, hatchetCtx }), () =>
      sendEmail(baseSend(stateId, `${RUN}-u13`, "welcome")),
    );
    // memo was NOT consulted; the real effect ran and the Layer-2 key was set.
    expect(hatchetCtx.memo).not.toHaveBeenCalled();
    expect(sendCalls[0]?.idempotencyKey).toBe(
      `journeySend:${stateId}:welcome:welcome`,
    );
  });
});

describe("ctx.trigger — replay re-push is a no-op via user_events unique index", () => {
  it("re-pushing the same trigger inserts user_events ONCE", async () => {
    const userId = `${RUN}-trig`;
    const stateId = `${RUN}-s9`;
    const fire = () =>
      runWithJourneyBoundary(makeBoundary({ stateId }), () => {
        const ctx = makeCtx({
          stateId,
          userId,
          userEmail: `${userId}@example.com`,
        });
        return ctx.trigger({
          event: "nps.detractor",
          userId,
          properties: { score: 3 },
        });
      });

    await fire();
    // Replay-from-top: the same trigger fires again with the same derived key.
    await fire();

    const rows = await db
      .select({ id: userEvents.id })
      .from(userEvents)
      .where(
        and(
          eq(userEvents.userId, userId),
          eq(userEvents.event, "nps.detractor"),
        ),
      );
    expect(rows).toHaveLength(1);
    // The first push fired; the deduped second trigger never reached events.push.
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it("derives a journeyTrigger:<anchor>:<site>:<event> key", () => {
    const key = deriveJourneyKey({
      kind: "trigger",
      anchor: "st1",
      site: "ev",
      discriminant: "ev",
    });
    expect(key).toBe("journeyTrigger:st1:ev:ev");
  });
});

describe("ctx.now — replay-stable clock", () => {
  it("returns the memoized instant when the engine provides now()", async () => {
    const fixed = new Date("2026-01-01T00:00:00.000Z");
    const ctx = makeCtx({
      stateId: `${RUN}-s10`,
      userId: `${RUN}-u10`,
      userEmail: "a@example.com",
      now: () => Promise.resolve(fixed),
    });
    const a = await ctx.now();
    const b = await ctx.now();
    expect(a.toISOString()).toBe(fixed.toISOString());
    expect(b.toISOString()).toBe(fixed.toISOString());
  });

  it("falls back to the live clock when now() is absent (pre-eviction)", async () => {
    const ctx = makeCtx({
      stateId: `${RUN}-s11`,
      userId: `${RUN}-u11`,
      userEmail: "a@example.com",
    });
    const before = Date.now();
    const t = await ctx.now();
    const after = Date.now();
    expect(t.getTime()).toBeGreaterThanOrEqual(before);
    expect(t.getTime()).toBeLessThanOrEqual(after);
  });
});

/**
 * THE LOAD-BEARING PROOF — real mailer, real Postgres unique index.
 *
 * The describe blocks above prove the KEY derivation and the trigger path (real
 * user_events unique index). This block closes the highest-blast-radius gap
 * end-to-end: it drives the REAL `createTrackedMailer` → `sendTrackedEmail`
 * against the REAL `email_sends_idempotency_key_idx` unique constraint in
 * TimescaleDB, with a provider whose `send` is COUNTED. A simulated replay (the
 * same journey-derived key sent twice) must yield EXACTLY ONE provider call and
 * EXACTLY ONE row — with NO mock standing in for the dedup.
 */
describe("REAL mailer + REAL email_sends unique index — exactly-once on replay", () => {
  // A real EmailProvider whose only job is to count send() calls. If the engine's
  // unique-index short-circuit works, this is hit ONCE even when send() is called
  // twice with the same derived key.
  let providerSends: Array<{ to: string | string[] }> = [];
  function makeCountingProvider(): EmailProvider {
    let n = 0;
    return {
      meta: { id: "resend", name: "counting-test" },
      capabilities: { nativeTracking: false },
      send: async (opts) => {
        providerSends.push({ to: opts.to });
        n += 1;
        return { id: `prov-msg-${n}` };
      },
      sendBatch: async () => ({ results: [] }),
      verifyWebhook: () => {
        throw new Error("unused");
      },
      parseWebhook: () => {
        throw new Error("unused");
      },
    };
  }

  function makeRealMailer() {
    providerSends = [];
    return createTrackedMailer(
      {
        defaultFrom: "Hogsend <noreply@hogsend.com>",
        // biome-ignore lint/suspicious/noExplicitAny: real container db threaded in
        db: db as any,
        templates,
      },
      { provider: makeCountingProvider() },
    );
  }

  // The exact options shape `sendEmail()`/the mailer build for a journey send —
  // skipPreferenceCheck isolates the idempotency mechanism from suppression. The
  // mailer is passed in so multiple sends share ONE provider's call counter. The
  // key is the branch-stable key journeys auto-derive (passed explicitly here so
  // the test mirrors what the journey send path threads through).
  function journeySend(
    mailer: ReturnType<typeof makeRealMailer>,
    stateId: string,
    userId: string,
  ) {
    return mailer.send({
      template: "welcome",
      props: { name: "Ada" },
      to: `${userId}@example.com`,
      subject: "Welcome to Hogsend",
      journeyStateId: stateId,
      userId,
      userEmail: `${userId}@example.com`,
      category: "transactional",
      skipPreferenceCheck: true,
      idempotencyKey: `journeySend:${stateId}:welcome:welcome`,
    });
  }

  it("sending the SAME journey key twice (replay) → ONE provider call, ONE row", async () => {
    const userId = `${RUN}-real-1`;
    // email_sends.journey_state_id FKs journey_states — seed a real enrollment.
    const stateId = await seedState(userId, `${RUN}-real-journey-1`);
    const mailer = makeRealMailer();

    // Original run sends the welcome.
    const first = await journeySend(mailer, stateId, userId);
    expect(first.status).toBe("sent");

    // Worker crash → Hatchet replays run() from the top → the SAME logical send
    // fires again with the SAME derived key.
    const second = await journeySend(mailer, stateId, userId);

    // EXACTLY-ONCE: the provider wire was hit ONCE; the replay short-circuited.
    expect(providerSends).toHaveLength(1);
    // The replay resolves to the SAME prior send (returned by the unique-index
    // short-circuit), not a fresh dispatch.
    expect(second.emailSendId).toBe(first.emailSendId);

    // And the database holds EXACTLY ONE email_sends row for that key.
    const rows = await db
      .select({ id: emailSends.id, status: emailSends.status })
      .from(emailSends)
      .where(
        eq(emailSends.idempotencyKey, `journeySend:${stateId}:welcome:welcome`),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("sent");
  });

  it("a DIFFERENT enrollment (distinct stateId) is NOT wrongly deduped", async () => {
    const userId = `${RUN}-real-2`;
    // Two distinct enrollments (distinct journeyIds satisfy the partial unique idx).
    const stateA = await seedState(userId, `${RUN}-real-journey-2a`);
    const stateB = await seedState(userId, `${RUN}-real-journey-2b`);
    const mailer = makeRealMailer();

    await journeySend(mailer, stateA, userId);
    await journeySend(mailer, stateB, userId);

    // Two distinct enrollments => two distinct keys => two real sends + two rows.
    expect(providerSends).toHaveLength(2);
    const rows = await db
      .select({ id: emailSends.id })
      .from(emailSends)
      .where(eq(emailSends.userId, userId));
    expect(rows).toHaveLength(2);
  });
});
