import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import { environments, organizations, stackAlerts, stacks } from "../db/schema";
import { env } from "../env";
import type { EmailMessage, EmailSender } from "../lib/email-sender";
import { sweepStackAlerts } from "../pipeline/alert-sweep";
import { DEFAULT_PROVISION_ATTEMPT_CEILING } from "../pipeline/provision-sweep";
import type { StackStatus } from "../services/stacks";

/**
 * The alert sweep, against the real control-plane database.
 *
 * The transport is INJECTED — a spy — because every assertion here is about
 * WHICH conditions produced a message and how often, not about a mail API.
 *
 * The clock is injected too. The whole feature is a statement about elapsed
 * time (a threshold, a cooldown), and a test that measured either against the
 * wall clock would be either slow or a race.
 */

const ORG_ID = "alert-sweep-test-org";
const ORG_NAME = "Alert Sweep Test";
const NOW = new Date("2026-03-01T12:00:00.000Z");
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * The sweep is UNSCOPED — it visits every stack in the database — so each test
 * starts from an empty stack table, and the delete is GLOBAL rather than scoped
 * to `ORG_ID`. A stack belonging to any other org (a row left by local
 * development, or by another suite) would fire conditions this test never
 * seeded and show up in `alerted` as a phantom. Environments cascade to stacks,
 * and stacks cascade to stack_alerts, so one delete clears all three.
 */
beforeEach(async () => {
  await db.delete(environments);
  await db.delete(stackAlerts);
});

interface SeedOptions {
  status: StackStatus;
  lastError?: string;
  retryCount?: number;
  updatedAt?: Date;
  substrateRefs?: Record<string, unknown>;
}

async function seedStack(options: SeedOptions): Promise<string> {
  const suffix = randomBytes(4).toString("hex");
  const [environment] = await db
    .insert(environments)
    .values({
      organizationId: ORG_ID,
      name: `alert-${suffix}`,
      kind: "test",
    })
    .returning();
  if (!environment) throw new Error("fixture environment not created");

  const [row] = await db
    .insert(stacks)
    .values({
      organizationId: ORG_ID,
      environmentId: environment.id,
      region: "us",
      status: options.status,
      lastError: options.lastError ?? null,
      retryCount: options.retryCount ?? 0,
      substrateRefs: options.substrateRefs ?? {},
      // Written explicitly: every threshold in the sweep reads `updated_at`,
      // and a fixture that let the default stand would only test "just now".
      updatedAt: options.updatedAt ?? NOW,
    })
    .returning();
  if (!row) throw new Error("fixture stack not created");
  return row.id;
}

/** A transport that records instead of sending. */
function spy(): EmailSender & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    id: "spy",
    sent,
    async send(message) {
      sent.push(message);
    },
  };
}

/** The sweep with a fixed clock and a spy, at an offset from `NOW`. */
function sweep(sender: EmailSender, offsetMs = 0) {
  return sweepStackAlerts({
    db,
    sender,
    destination: "ops@example.com",
    now: () => new Date(NOW.getTime() + offsetMs),
  });
}

/** A stack that has been `error` long enough to trip the general net. */
const STALE = new Date(NOW.getTime() - 2 * HOUR);

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await db
    .insert(organizations)
    .values({ id: ORG_ID, name: ORG_NAME, region: "us" })
    .onConflictDoNothing();
});

afterAll(async () => {
  await db.delete(environments).where(eq(environments.organizationId, ORG_ID));
  await db.delete(organizations).where(eq(organizations.id, ORG_ID));
  await sqlClient.end({ timeout: 5 });
});

describe("sweepStackAlerts conditions", () => {
  it("alerts on a stack stuck in a non-running status", async () => {
    const stackId = await seedStack({ status: "error", updatedAt: STALE });
    const sender = spy();

    const result = await sweep(sender);

    expect(result.alerted).toEqual([{ stackId, conditions: ["non_running"] }]);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.to).toBe("ops@example.com");
    expect(sender.sent[0]?.subject).toContain(ORG_NAME);
    // The facts an operator needs at 2am: which stack, how long, what next.
    expect(sender.sent[0]?.text).toContain(stackId);
    expect(sender.sent[0]?.text).toContain("2 hours");
    expect(sender.sent[0]?.text).toContain("not serving");
  });

  it("stays quiet about a stack that has only just left running", async () => {
    await seedStack({
      status: "provisioning",
      updatedAt: new Date(NOW.getTime() - 5 * MINUTE),
    });
    const sender = spy();

    const result = await sweep(sender);

    expect(result.alerted).toEqual([]);
    expect(sender.sent).toEqual([]);
  });

  it("stays quiet about a stack an operator deliberately suspended", async () => {
    await seedStack({ status: "suspended", updatedAt: STALE });
    const sender = spy();

    expect((await sweep(sender)).alerted).toEqual([]);
  });

  it("alerts on a stack the provision sweep gave up on", async () => {
    const stackId = await seedStack({
      status: "error",
      lastError: "[set-env] Problem processing request",
      retryCount: DEFAULT_PROVISION_ATTEMPT_CEILING,
      updatedAt: STALE,
    });
    const sender = spy();

    const result = await sweep(sender);

    expect(result.alerted[0]?.stackId).toBe(stackId);
    expect(result.alerted[0]?.conditions).toContain("provision_exhausted");
    expect(sender.sent[0]?.text).toContain(
      "will not re-drive this stack again",
    );
  });

  it("alerts on a running stack with no minted credentials", async () => {
    const stackId = await seedStack({
      status: "running",
      substrateRefs: { credentialsMinted: false },
    });
    const sender = spy();

    const result = await sweep(sender);

    expect(result.alerted).toEqual([
      { stackId, conditions: ["needs_credentials"] },
    ]);
    expect(sender.sent[0]?.text).toContain("cannot log in");
  });

  it("stays quiet about a running stack whose credentials were minted", async () => {
    await seedStack({
      status: "running",
      substrateRefs: { credentialsMinted: true },
    });
    const sender = spy();

    expect((await sweep(sender)).alerted).toEqual([]);
  });
});

describe("sweepStackAlerts dedupe", () => {
  it("does not repeat an unchanged condition on the next tick", async () => {
    await seedStack({
      status: "running",
      substrateRefs: { credentialsMinted: false },
    });
    const sender = spy();

    await sweep(sender);
    // Five minutes later — the shape of the real cron, and the exact case that
    // would page the operator forever without the record.
    const second = await sweep(sender, 5 * MINUTE);

    expect(second.alerted).toEqual([]);
    expect(second.suppressed).toBe(1);
    expect(sender.sent).toHaveLength(1);
  });

  it("repeats an unchanged condition once the cooldown has passed", async () => {
    await seedStack({
      status: "running",
      substrateRefs: { credentialsMinted: false },
    });
    const sender = spy();

    await sweep(sender);
    const later = await sweep(sender, 25 * HOUR);

    expect(later.alerted).toHaveLength(1);
    expect(sender.sent).toHaveLength(2);
  });

  it("alerts again when the condition changes for that stack", async () => {
    const stackId = await seedStack({
      status: "provisioning",
      updatedAt: STALE,
    });
    const sender = spy();

    await sweep(sender);
    // The stack moved on to a different failure. Same rule, new fact — and
    // inside the cooldown, so only the fingerprint can let this through.
    await db
      .update(stacks)
      .set({ status: "error", updatedAt: STALE })
      .where(eq(stacks.id, stackId));
    const second = await sweep(sender, 5 * MINUTE);

    expect(second.alerted).toEqual([{ stackId, conditions: ["non_running"] }]);
    expect(sender.sent[1]?.text).toContain("Status: error");
  });

  it("alerts again when a cleared condition recurs", async () => {
    const stackId = await seedStack({
      status: "running",
      substrateRefs: { credentialsMinted: false },
    });
    const sender = spy();

    await sweep(sender);

    // Fixed, so the condition stops matching and the record is cleared.
    await db
      .update(stacks)
      .set({ substrateRefs: { credentialsMinted: true } })
      .where(eq(stacks.id, stackId));
    const cleared = await sweep(sender, 5 * MINUTE);
    expect(cleared.cleared).toEqual([
      { stackId, condition: "needs_credentials" },
    ]);

    // Broken again, still well inside the cooldown. A stale record would
    // swallow this, which is the failure that makes dedupe dangerous.
    await db
      .update(stacks)
      .set({ substrateRefs: { credentialsMinted: false } })
      .where(eq(stacks.id, stackId));
    const again = await sweep(sender, 10 * MINUTE);

    expect(again.alerted).toEqual([
      { stackId, conditions: ["needs_credentials"] },
    ]);
    expect(sender.sent).toHaveLength(2);
  });

  it("keeps a per-condition memory, so a second condition still speaks", async () => {
    const stackId = await seedStack({
      status: "error",
      lastError: "[set-env] Problem processing request",
      updatedAt: STALE,
    });
    const sender = spy();

    await sweep(sender);

    // The provision sweep has since burned the ceiling on the same stack.
    await db
      .update(stacks)
      .set({ retryCount: DEFAULT_PROVISION_ATTEMPT_CEILING, updatedAt: STALE })
      .where(eq(stacks.id, stackId));
    const second = await sweep(sender, 5 * MINUTE);

    expect(second.alerted).toEqual([
      { stackId, conditions: ["provision_exhausted"] },
    ]);
    expect(second.suppressed).toBe(1);
  });

  it("does not record a condition whose notice could not be sent", async () => {
    await seedStack({
      status: "running",
      substrateRefs: { credentialsMinted: false },
    });
    const broken: EmailSender = {
      id: "broken",
      async send() {
        throw new Error("mail provider unreachable");
      },
    };

    const first = await sweepStackAlerts({
      db,
      sender: broken,
      destination: "ops@example.com",
      now: () => NOW,
    });
    expect(first.failed).toHaveLength(1);
    expect(await db.select().from(stackAlerts)).toEqual([]);

    // The next tick still says it, because the first tick never did.
    const sender = spy();
    expect((await sweep(sender, 5 * MINUTE)).alerted).toHaveLength(1);
  });
});

describe("sweepStackAlerts transport", () => {
  it("falls back to the log transport when no destination is configured", async () => {
    await seedStack({
      status: "running",
      substrateRefs: { credentialsMinted: false },
    });
    const logged: string[] = [];
    const original = console.log;
    console.log = (line: string) => {
      logged.push(line);
    };

    try {
      // No `sender` and an explicitly absent destination: exactly a fresh clone
      // with no mail provider, which must not be able to reach the network.
      const result = await sweepStackAlerts({
        db,
        destination: null,
        now: () => NOW,
      });
      expect(result.alerted).toHaveLength(1);
    } finally {
      console.log = original;
    }

    expect(logged.some((line) => line.includes("[cloud:email:log]"))).toBe(
      true,
    );
  });
});
