/**
 * Replay-safety EDGE cases, each closing a specific adversarial-review finding:
 *
 *  1. QUEUED re-drive (MF-2): a prior "queued" email_sends row (worker crashed
 *     after the insert, before the provider returned / status flip) is RE-DRIVEN
 *     on replay, NOT short-circuited as a satisfied duplicate — so a never-sent
 *     mail is not silently suppressed. No duplicate row (the queued row is
 *     reused).
 *  2. RAW getEmailService().send() inside a journey is auto-keyed by the engine
 *     (MF-6): the boundary auto-keying lives in the tracked mailer, so a journey
 *     that bypasses the sendEmail() helper still gets exactly-once.
 *  3. sendConnectorAction is boundary-aware (MF-5): Layer-1 memoize wraps the
 *     action so a replay on an eviction-capable engine does not re-fire it, AND
 *     the Layer-2 `connector_deliveries` DB backstop makes it exactly-once even
 *     on a pre-eviction (degraded) engine — the version-independent guarantee.
 *  4. ctx.once (MF-8): a non-deterministic decision is recorded once per
 *     enrollment and replayed verbatim, durable on ANY engine.
 */

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { connectorDeliveries, emailSends, journeyStates } = await import(
  "@hogsend/db"
);
const { eq } = await import("drizzle-orm");
const {
  createHogsendClient,
  createJourneyContext,
  createMemoize,
  deriveJourneyKey,
  createTrackedMailer,
  defineConnectorAction,
  getEmailService,
  resetConnectorActionRegistry,
  runWithJourneyBoundary,
  sendConnectorAction,
  ConnectorActionRegistry,
  setConnectorActionRegistry,
  setEmailService,
} = await import("@hogsend/engine");
type JourneyBoundary = import("@hogsend/engine").JourneyBoundary;
type EmailProvider = import("@hogsend/engine").EmailProvider;
type JourneyContext = import("@hogsend/core/types").JourneyContext;
const { templates } = await import("../emails/index.js");

const mockHatchet = {
  durableTask: () => ({ run: () => {}, runNoWait: () => {} }),
  task: () => ({ run: () => {}, runNoWait: () => {} }),
  events: { push: async () => {} },
  runs: { cancel: () => {}, get: () => {} },
  worker: () => {},
} as unknown as ReturnType<typeof createHogsendClient>["hatchet"];

const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const { db } = container;

const RUN = `jre-${Date.now()}`;

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

function installRealMailer() {
  providerSends = [];
  const mailer = createTrackedMailer(
    {
      defaultFrom: "Hogsend <noreply@hogsend.com>",
      // biome-ignore lint/suspicious/noExplicitAny: real container db threaded in
      db: db as any,
      templates,
    },
    { provider: makeCountingProvider() },
  );
  // biome-ignore lint/suspicious/noExplicitAny: mailer satisfies EmailService
  setEmailService(mailer as any);
}

function makeBoundary(opts: {
  stateId: string;
  // biome-ignore lint/suspicious/noExplicitAny: minimal hatchetCtx stub
  hatchetCtx?: any;
}): JourneyBoundary {
  return {
    stateId: opts.stateId,
    runAnchor: opts.stateId,
    currentLabel: undefined,
    seenKeys: new Set<string>(),
    seenRecordLabels: new Set<string>(),
    memoize: createMemoize(opts.hatchetCtx ?? {}),
  };
}

function makeCtx(stateId: string, userId: string): JourneyContext {
  return createJourneyContext({
    db: db as Parameters<typeof createJourneyContext>[0]["db"],
    hatchet: mockHatchet as Parameters<
      typeof createJourneyContext
    >[0]["hatchet"],
    hatchetCtx: {
      sleepFor: (async () => ({})) as unknown as (
        d: unknown,
      ) => Promise<unknown>,
      waitFor: (async () => ({})) as unknown as (
        c: unknown,
      ) => Promise<Record<string, unknown>>,
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
    registry: { get: () => undefined } as any,
    // biome-ignore lint/suspicious/noExplicitAny: minimal logger stub
    logger: { info: () => {}, warn: () => {}, error: () => {} } as any,
    stateId,
    userId,
    userEmail: `${userId}@example.com`,
    journeyContext: {},
    resolvedTimezone: "UTC",
  }) as unknown as JourneyContext;
}

async function seedState(userId: string): Promise<string> {
  const [row] = await db
    .insert(journeyStates)
    .values({
      userId,
      userEmail: `${userId}@example.com`,
      journeyId: `${RUN}-journey`,
      currentNodeId: "start",
      status: "active",
    })
    .returning({ id: journeyStates.id });
  return row?.id ?? "";
}

beforeEach(() => {
  installRealMailer();
});

afterAll(async () => {
  for (const s of [
    "queued",
    "raw",
    "conn",
    "conn2",
    "conn3",
    "conn3b",
    "once",
  ]) {
    const uid = `${RUN}-${s}`;
    await db.delete(emailSends).where(eq(emailSends.userId, uid));
    await db.delete(journeyStates).where(eq(journeyStates.userId, uid));
  }
  // The connector tests own connector id "test"; clear their dedupe rows so a
  // re-run against the same DB starts clean.
  await db
    .delete(connectorDeliveries)
    .where(eq(connectorDeliveries.connectorId, "test"));
  resetConnectorActionRegistry();
});

describe("queued-row re-drive (crash before provider returned)", () => {
  it("re-drives an orphaned 'queued' row instead of suppressing it", async () => {
    const userId = `${RUN}-queued`;
    const stateId = await seedState(userId);
    const key = `journeySend:${stateId}:queued-test:welcome`;

    // Simulate a crashed prior attempt: a 'queued' row with the key, NO provider
    // call recorded, NO status flip.
    await db.insert(emailSends).values({
      templateKey: "welcome",
      fromEmail: "Hogsend <noreply@hogsend.com>",
      toEmail: `${userId}@example.com`,
      subject: "Welcome",
      category: "journey",
      journeyStateId: stateId,
      userId,
      userEmail: `${userId}@example.com`,
      status: "queued",
      idempotencyKey: key,
    });

    // The replay re-sends with the SAME key. The short-circuit must NOT treat the
    // queued row as a duplicate — it re-drives the provider and reuses the row.
    const mailer = getEmailService();
    await mailer.send({
      template: "welcome",
      props: { name: "Ada" },
      to: `${userId}@example.com`,
      subject: "Welcome",
      userId,
      userEmail: `${userId}@example.com`,
      journeyStateId: stateId,
      category: "journey",
      idempotencyKey: key,
      // biome-ignore lint/suspicious/noExplicitAny: loose mailer send options
    } as any);

    // The provider WAS hit (the never-sent mail went out), and there is still
    // exactly ONE row for the key (the queued row was reused, not duplicated).
    expect(providerSends).toHaveLength(1);
    const rows = await db
      .select({ id: emailSends.id, status: emailSends.status })
      .from(emailSends)
      .where(eq(emailSends.idempotencyKey, key));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("sent");

    // A SECOND replay now finds a 'sent' row → short-circuits, no second send.
    await mailer.send({
      template: "welcome",
      props: { name: "Ada" },
      to: `${userId}@example.com`,
      subject: "Welcome",
      userId,
      userEmail: `${userId}@example.com`,
      journeyStateId: stateId,
      category: "journey",
      idempotencyKey: key,
      // biome-ignore lint/suspicious/noExplicitAny: loose mailer send options
    } as any);
    expect(providerSends).toHaveLength(1);
  });
});

describe("raw getEmailService().send() inside a journey is auto-keyed", () => {
  it("a raw service send re-fired on replay does not duplicate", async () => {
    const userId = `${RUN}-raw`;
    const stateId = await seedState(userId);

    // A journey that reaches for the RAW service (bypassing sendEmail()). The
    // tracked mailer derives the key from the active boundary.
    const rawSend = () =>
      getEmailService().send({
        template: "welcome",
        props: { name: "Ada" },
        to: `${userId}@example.com`,
        subject: "Welcome",
        userId,
        userEmail: `${userId}@example.com`,
        journeyStateId: stateId,
        category: "journey",
        // biome-ignore lint/suspicious/noExplicitAny: loose mailer send options
      } as any);

    await runWithJourneyBoundary(makeBoundary({ stateId }), rawSend);
    // Replay: fresh boundary, same stateId → same derived key → deduped.
    await runWithJourneyBoundary(makeBoundary({ stateId }), rawSend);

    expect(providerSends).toHaveLength(1);
    const rows = await db
      .select({ id: emailSends.id })
      .from(emailSends)
      .where(eq(emailSends.userId, userId));
    expect(rows).toHaveLength(1);
  });
});

describe("sendConnectorAction is boundary-aware (Layer-1 memoize)", () => {
  it("eviction ON: a replayed connector action is NOT re-fired", async () => {
    const userId = `${RUN}-conn`;
    const stateId = await seedState(userId);

    let runs = 0;
    const action = defineConnectorAction({
      connectorId: "test",
      name: "ping",
      run: async () => {
        runs += 1;
        return { ok: true };
      },
    });
    const reg = new ConnectorActionRegistry([action]);
    setConnectorActionRegistry(reg);

    // A memo stub that records by deps and returns the recorded result verbatim
    // on the second call with the same deps (eviction-live behaviour).
    const recorded = new Map<string, unknown>();
    const hatchetCtx = {
      supportsEviction: true,
      memo: vi.fn(async (fn: () => Promise<unknown>, deps: unknown[]) => {
        const k = JSON.stringify(deps);
        if (recorded.has(k)) return recorded.get(k);
        const v = await fn();
        recorded.set(k, v);
        return v;
      }),
    };

    const call = () =>
      sendConnectorAction({ connectorId: "test", action: "ping" });

    await runWithJourneyBoundary(makeBoundary({ stateId, hatchetCtx }), call);
    await runWithJourneyBoundary(makeBoundary({ stateId, hatchetCtx }), call);

    // Two boundaries (original + replay) share the recorded memo, so the action
    // body ran ONCE.
    expect(runs).toBe(1);
  });

  it("eviction OFF: Layer-2 DB backstop still makes the action exactly-once", async () => {
    const userId = `${RUN}-conn2`;
    const stateId = await seedState(userId);

    let runs = 0;
    const action = defineConnectorAction({
      connectorId: "test",
      name: "ping2",
      run: async () => {
        runs += 1;
        return { ok: true, n: runs };
      },
    });
    setConnectorActionRegistry(new ConnectorActionRegistry([action]));

    const call = () =>
      sendConnectorAction({ connectorId: "test", action: "ping2" });
    // Degraded engine: no durable memo → Layer-1 falls through to fn(). The
    // Layer-2 `connector_deliveries` short-circuit is what guarantees
    // exactly-once on a pre-eviction engine: the first run claims the
    // (connectorId, dedupeKey) row + stores the result; the replay finds the
    // terminal "sent" row and replays the stored result WITHOUT re-running.
    const first = await runWithJourneyBoundary(makeBoundary({ stateId }), call);
    const second = await runWithJourneyBoundary(
      makeBoundary({ stateId }),
      call,
    );
    expect(runs).toBe(1);
    // The replay returns the FIRST run's stored result (round-tripped through
    // the jsonb column), not a fresh invocation.
    expect(second).toEqual(first);
    expect(second).toEqual({ ok: true, n: 1 });

    // EXACTLY ONE durable delivery row resulted from the two boundary runs: the
    // replay claimed nothing new, it short-circuited on the first run's terminal
    // "sent" row. Scope by the EXACT derived dedupe key (the connector path uses
    // `currentLabel ?? "<connectorId>:<action>"` as `site`, here "test:ping2",
    // anchored on the boundary runAnchor = stateId) so the assertion is isolated
    // from any other run's rows. This is the version-independent (Layer-2)
    // guarantee.
    const dedupeKey = deriveJourneyKey({
      kind: "connector",
      anchor: stateId,
      site: "test:ping2",
      discriminant: "test:ping2",
    });
    const rows = await db
      .select({
        status: connectorDeliveries.status,
        result: connectorDeliveries.result,
      })
      .from(connectorDeliveries)
      .where(eq(connectorDeliveries.dedupeKey, dedupeKey));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("sent");
    expect(rows[0]?.result).toEqual({ ok: true, n: 1 });
  });

  it("idempotencyLabel escape hatch: two distinct sends of the SAME action in one run", async () => {
    const userId = `${RUN}-conn3`;
    const stateId = await seedState(userId);

    // A real multi-target action: the action's `args` are NOT part of the
    // derived key, so two distinct sends of the SAME action within one run (no
    // intervening ctx.sleep/waitForEvent/checkpoint advancing the nearest label)
    // derive an IDENTICAL key.
    let runs = 0;
    const action = defineConnectorAction({
      connectorId: "test",
      name: "broadcast",
      run: async (args: unknown) => {
        runs += 1;
        return { ok: true, args };
      },
    });
    setConnectorActionRegistry(new ConnectorActionRegistry([action]));

    // WITHOUT idempotencyLabel: the second send derives the same key and
    // fail-fasts via registerKey (the intended loud footgun, NOT a silent drop).
    runs = 0;
    await expect(
      runWithJourneyBoundary(makeBoundary({ stateId }), async () => {
        await sendConnectorAction({
          connectorId: "test",
          action: "broadcast",
          args: { channelId: "A", content: "hi" },
        });
        await sendConnectorAction({
          connectorId: "test",
          action: "broadcast",
          args: { channelId: "B", content: "hi" },
        });
      }),
    ).rejects.toThrow(/duplicate idempotency key/);

    // WITH distinct idempotencyLabels: both sends fire (the escape hatch makes
    // the multi-target pattern expressible) and yield two distinct delivery rows.
    runs = 0;
    const labelStateId = await seedState(`${RUN}-conn3b`);
    await runWithJourneyBoundary(
      makeBoundary({ stateId: labelStateId }),
      async () => {
        await sendConnectorAction({
          connectorId: "test",
          action: "broadcast",
          args: { channelId: "A", content: "hi" },
          idempotencyLabel: "channel-A",
        });
        await sendConnectorAction({
          connectorId: "test",
          action: "broadcast",
          args: { channelId: "B", content: "hi" },
          idempotencyLabel: "channel-B",
        });
      },
    );
    expect(runs).toBe(2);

    const keyA = deriveJourneyKey({
      kind: "connector",
      anchor: labelStateId,
      site: "channel-A",
      discriminant: "test:broadcast",
    });
    const keyB = deriveJourneyKey({
      kind: "connector",
      anchor: labelStateId,
      site: "channel-B",
      discriminant: "test:broadcast",
    });
    const labelRows = await db
      .select({ dedupeKey: connectorDeliveries.dedupeKey })
      .from(connectorDeliveries)
      .where(eq(connectorDeliveries.action, "broadcast"));
    const keys = labelRows.map((r) => r.dedupeKey).filter(Boolean);
    expect(keys).toContain(keyA);
    expect(keys).toContain(keyB);
  });
});

describe("ctx.once records a decision once per enrollment (durable on any engine)", () => {
  it("re-running the journey replays the recorded value without recomputing", async () => {
    const userId = `${RUN}-once`;
    const stateId = await seedState(userId);
    const ctx = makeCtx(stateId, userId);

    let computes = 0;
    const compute = () => {
      computes += 1;
      return { action: `decision-${computes}` };
    };

    const first = await ctx.once("decision", compute);
    // A replay (even on a pre-eviction engine) reads the stored value — compute
    // is NOT called again, and the SAME value comes back.
    const second = await ctx.once("decision", compute);
    // A fresh ctx for the same enrollment (replay-from-top rebuilds ctx).
    const third = await makeCtx(stateId, userId).once("decision", compute);

    expect(computes).toBe(1);
    expect(first).toEqual({ action: "decision-1" });
    expect(second).toEqual({ action: "decision-1" });
    expect(third).toEqual({ action: "decision-1" });
  });
});
