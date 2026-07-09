import type { EmailProvider, SendEmailOptions } from "@hogsend/core";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// DB-touching test: real docker TimescaleDB (mirrors campaigns-dataplane.test.ts).
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Config-preserving Hatchet mock — `reconcileDefinedCampaigns` dispatches the
// punctual trigger via `sendCampaignTask.schedule(...)` (future sendAt) or
// `.runNoWait(...)` (due within grace); both land on these hoisted spies.
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

const { campaigns } = await import("@hogsend/db");
const { eq, like } = await import("drizzle-orm");
const {
  createHogsendClient,
  DEFINED_CAMPAIGN_KEY_PREFIX,
  defineCampaign,
  defineList,
  reconcileDefinedCampaigns,
} = await import("@hogsend/engine");
const { templates } = await import("../emails/index.js");
const { productUpdates } = await import("../lists/index.js");

const providerSend = vi.fn(async (_opts: SendEmailOptions) => ({
  id: "fake-id",
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

const RUN = `crc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const newsletter = defineList({
  id: "reconcile-newsletter",
  name: "Reconcile newsletter",
  defaultOptIn: false,
});

const container = createHogsendClient({
  email: { provider: fakeProvider, templates },
  lists: [newsletter, productUpdates],
});
const { db } = container;

/** The definition ids this file mints (cleaned up in afterAll). */
const definedIds: string[] = [];
function defId(slug: string): string {
  const id = `${RUN}-${slug}`;
  definedIds.push(id);
  return id;
}

function rowFor(id: string) {
  return db
    .select()
    .from(campaigns)
    .where(eq(campaigns.idempotencyKey, `${DEFINED_CAMPAIGN_KEY_PREFIX}${id}`));
}

beforeEach(() => {
  runNoWaitSpy.mockClear();
  scheduleSpy.mockClear();
});

afterAll(async () => {
  await db
    .delete(campaigns)
    .where(
      like(campaigns.idempotencyKey, `${DEFINED_CAMPAIGN_KEY_PREFIX}${RUN}-%`),
    );
});

describe("reconcileDefinedCampaigns", () => {
  it("creates a scheduled row + punctual run for a future definition; a re-run is a no-op", async () => {
    const id = defId("future");
    const sendAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const definition = defineCampaign({
      id,
      name: "Future blast",
      audience: { list: "reconcile-newsletter" },
      template: "welcome",
      props: { name: "Ada" },
      subject: "Hello",
      sendAt,
    });

    const first = await reconcileDefinedCampaigns({
      client: container,
      campaigns: [definition],
    });
    expect(first.created).toBe(1);

    const [row] = await rowFor(id);
    expect(row?.status).toBe("scheduled");
    expect(row?.scheduledAt?.toISOString()).toBe(sendAt.toISOString());
    expect(row?.templateKey).toBe("welcome");
    expect(scheduleSpy).toHaveBeenCalledTimes(1);

    // Unchanged redeploy: no new row, no update, no new dispatch.
    scheduleSpy.mockClear();
    const second = await reconcileDefinedCampaigns({
      client: container,
      campaigns: [definition],
    });
    expect(second).toMatchObject({ created: 0, updated: 0, skipped: 1 });
    expect(scheduleSpy).not.toHaveBeenCalled();
    const rows = await rowFor(id);
    expect(rows.length).toBe(1);
  });

  it("syncs edits to a still-scheduled row; a moved sendAt re-schedules", async () => {
    const id = defId("edited");
    const sendAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const v1 = defineCampaign({
      id,
      name: "V1",
      audience: { list: "reconcile-newsletter" },
      template: "welcome",
      subject: "V1 subject",
      sendAt,
    });
    await reconcileDefinedCampaigns({ client: container, campaigns: [v1] });

    const movedTo = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const v2 = defineCampaign({
      id,
      name: "V2",
      audience: { list: "reconcile-newsletter" },
      template: "welcome",
      subject: "V2 subject",
      sendAt: movedTo,
    });
    scheduleSpy.mockClear();
    const result = await reconcileDefinedCampaigns({
      client: container,
      campaigns: [v2],
    });
    expect(result.updated).toBe(1);

    const [row] = await rowFor(id);
    expect(row?.name).toBe("V2");
    expect(row?.subject).toBe("V2 subject");
    expect(row?.scheduledAt?.toISOString()).toBe(movedTo.toISOString());
    // Fresh punctual run at the new instant.
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
  });

  it("marks a stale definition expired at first reconcile — never a surprise blast", async () => {
    const id = defId("stale");
    const definition = defineCampaign({
      id,
      audience: { list: "reconcile-newsletter" },
      template: "welcome",
      sendAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
    });

    const result = await reconcileDefinedCampaigns({
      client: container,
      campaigns: [definition],
    });
    expect(result.expired).toBe(1);

    const [row] = await rowFor(id);
    expect(row?.status).toBe("expired");
    expect(scheduleSpy).not.toHaveBeenCalled();
    expect(runNoWaitSpy).not.toHaveBeenCalled();
  });

  it("enqueues immediately when sendAt is past-due but inside the grace window", async () => {
    const id = defId("grace");
    const definition = defineCampaign({
      id,
      audience: { list: "reconcile-newsletter" },
      template: "welcome",
      sendAt: new Date(Date.now() - 5 * 60 * 1000), // 5 min ago < 1h grace
    });

    const result = await reconcileDefinedCampaigns({
      client: container,
      campaigns: [definition],
    });
    expect(result.created).toBe(1);
    expect(runNoWaitSpy).toHaveBeenCalledTimes(1);
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it("never touches a row that has left `scheduled` (sent = retired)", async () => {
    const id = defId("retired");
    const v1 = defineCampaign({
      id,
      name: "Retired",
      audience: { list: "reconcile-newsletter" },
      template: "welcome",
      sendAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    await reconcileDefinedCampaigns({ client: container, campaigns: [v1] });

    // Simulate the blast having gone out.
    const [row] = await rowFor(id);
    await db
      .update(campaigns)
      .set({ status: "sent", completedAt: new Date() })
      .where(eq(campaigns.id, (row as { id: string }).id));

    const v2 = defineCampaign({
      id,
      name: "Edited after send",
      audience: { list: "reconcile-newsletter" },
      template: "welcome",
      sendAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
    });
    scheduleSpy.mockClear();
    const result = await reconcileDefinedCampaigns({
      client: container,
      campaigns: [v2],
    });
    expect(result).toMatchObject({ created: 0, updated: 0, skipped: 1 });

    const [after] = await rowFor(id);
    expect(after?.status).toBe("sent");
    expect(after?.name).toBe("Retired");
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it("skips a definition whose audience or template is unknown (no row, no crash)", async () => {
    const unknownAudience = defineCampaign({
      id: defId("bad-audience"),
      audience: { list: "no-such-list" },
      template: "welcome",
      sendAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const unknownTemplate = defineCampaign({
      id: defId("bad-template"),
      audience: { list: "reconcile-newsletter" },
      // Cast: deliberately not a registered key.
      template: "no-such-template" as never,
      sendAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const result = await reconcileDefinedCampaigns({
      client: container,
      campaigns: [unknownAudience, unknownTemplate],
    });
    expect(result.skipped).toBe(2);
    expect(result.created).toBe(0);

    const rows = await db
      .select()
      .from(campaigns)
      .where(
        like(
          campaigns.idempotencyKey,
          `${DEFINED_CAMPAIGN_KEY_PREFIX}${RUN}-bad-%`,
        ),
      );
    expect(rows.length).toBe(0);
  });

  it("defineCampaign validates id, audience XOR, and sendAt at definition time", () => {
    expect(() =>
      defineCampaign({
        id: "bad id!",
        audience: { list: "x" },
        template: "welcome",
        sendAt: new Date(),
      }),
    ).toThrow(/Invalid campaign id/);

    expect(() =>
      defineCampaign({
        id: "both-audiences",
        // Cast: deliberately violating the XOR to hit the runtime guard.
        audience: { list: "a", bucket: "b" } as never,
        template: "welcome",
        sendAt: new Date(),
      }),
    ).toThrow(/exactly one/);

    expect(() =>
      defineCampaign({
        id: "bad-date",
        audience: { list: "x" },
        template: "welcome",
        sendAt: "not-a-date",
      }),
    ).toThrow(/not a valid Date/);
  });
});
