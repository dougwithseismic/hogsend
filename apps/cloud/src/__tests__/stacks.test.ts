import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import {
  cells,
  cloudAuditLog,
  environments,
  organizations,
  stacks,
} from "../db/schema";
import { env } from "../env";
import { IllegalTransitionError, NotFoundError } from "../services/errors";
import type { StackStatus } from "../services/stacks";
import { StackService } from "../services/stacks";

const CELL_NAME = "stacks-test-us-1";
const ORG = "stacks-test-org";

const service = new StackService(db);

/**
 * The transition table, written out BY HAND rather than imported from the
 * service.
 *
 * This is the point of the test: a matrix driven by `LEGAL_EDGES` would certify
 * whatever the implementation happens to say. Two independent copies of the law
 * must agree, so a typo on either side is a red test.
 */
const EXPECTED_LEGAL: ReadonlyArray<readonly [StackStatus, StackStatus]> = [
  ["requested", "provisioning"],
  ["provisioning", "running"],
  ["provisioning", "error"],
  ["running", "publishing"],
  ["publishing", "running"],
  ["publishing", "error"],
  ["running", "suspended"],
  ["suspended", "running"],
  ["suspended", "destroying"],
  ["destroying", "destroyed"],
  ["destroying", "error"],
  ["error", "provisioning"],
  ["error", "suspended"],
  ["error", "destroying"],
];

const ALL_STATUSES: readonly StackStatus[] = [
  "requested",
  "provisioning",
  "running",
  "publishing",
  "suspended",
  "destroying",
  "destroyed",
  "error",
];

function isLegal(from: StackStatus, to: StackStatus): boolean {
  return EXPECTED_LEGAL.some(([f, t]) => f === from && t === to);
}

let seq = 0;

/** Seed an environment + a stack parked in `status`, bypassing the service. */
async function seedStack(
  status: StackStatus,
  extra: { lastError?: string; retryCount?: number } = {},
): Promise<string> {
  seq += 1;
  const name = `env-${seq}`;
  const [environment] = await db
    .insert(environments)
    .values({ organizationId: ORG, name, kind: "test" })
    .returning();
  if (!environment) throw new Error("failed to seed environment");

  const [stack] = await db
    .insert(stacks)
    .values({
      organizationId: ORG,
      environmentId: environment.id,
      status,
      region: "us",
      lastError: extra.lastError ?? null,
      retryCount: extra.retryCount ?? 0,
    })
    .returning();
  if (!stack) throw new Error("failed to seed stack");
  return stack.id;
}

async function readStack(stackId: string) {
  const [row] = await db.select().from(stacks).where(eq(stacks.id, stackId));
  if (!row) throw new Error(`stack ${stackId} vanished`);
  return row;
}

async function auditFor(stackId: string) {
  return db
    .select()
    .from(cloudAuditLog)
    .where(eq(cloudAuditLog.subject, stackId))
    .orderBy(cloudAuditLog.createdAt);
}

async function cleanup(): Promise<void> {
  await db.delete(organizations).where(inArray(organizations.id, [ORG]));
  await db.delete(cells).where(eq(cells.name, CELL_NAME));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();

  const [cell] = await db
    .insert(cells)
    .values({
      name: CELL_NAME,
      region: "us",
      sharedClusterDsn: "v1:fake-dsn",
      sharedHatchetUrl: "http://hatchet.test:7077",
      maxTenants: 100,
    })
    .returning();
  if (!cell) throw new Error("failed to seed cell");

  await db.insert(organizations).values({
    id: ORG,
    name: "Stacks Test Org",
    region: "us",
    plan: "dedicated",
    cellId: null,
  });
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
});

describe("StackService.transition — the full 8x8 matrix", () => {
  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      const legal = isLegal(from, to);
      it(`${legal ? "allows" : "refuses"} ${from} -> ${to}`, async () => {
        const stackId = await seedStack(from);

        if (legal) {
          const stack = await service.transition({ stackId, to });
          expect(stack.status).toBe(to);
          expect((await readStack(stackId)).status).toBe(to);
          return;
        }

        await expect(
          service.transition({ stackId, to }),
        ).rejects.toBeInstanceOf(IllegalTransitionError);
        // An illegal edge leaves the row EXACTLY as it was.
        expect((await readStack(stackId)).status).toBe(from);
      });
    }
  }
});

describe("StackService.transition", () => {
  it("audits every legal transition with from/to/detail", async () => {
    const stackId = await seedStack("requested");
    await service.transition({
      stackId,
      to: "provisioning",
      actor: "provisioner",
      detail: { attempt: 1 },
    });

    const rows = await auditFor(stackId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("stack.transition");
    expect(rows[0]?.actor).toBe("provisioner");
    expect(rows[0]?.organizationId).toBe(ORG);
    expect(rows[0]?.detail).toMatchObject({
      from: "requested",
      to: "provisioning",
      attempt: 1,
    });
  });

  it("writes no audit row for an illegal transition", async () => {
    const stackId = await seedStack("destroyed");
    await expect(
      service.transition({ stackId, to: "running" }),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
    expect(await auditFor(stackId)).toHaveLength(0);
  });

  it("carries the observed from/to on the error", async () => {
    const stackId = await seedStack("running");
    const error = await service
      .transition({ stackId, to: "destroying" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(IllegalTransitionError);
    const illegal = error as IllegalTransitionError;
    expect(illegal.from).toBe("running");
    expect(illegal.to).toBe("destroying");
    expect(illegal.code).toBe("illegal_transition");
  });

  it("refuses an expectedFrom mismatch and leaves the row unchanged", async () => {
    const stackId = await seedStack("running");

    // publishing -> running IS a legal edge, but this stack is not publishing.
    await expect(
      service.transition({
        stackId,
        to: "running",
        expectedFrom: "publishing",
      }),
    ).rejects.toBeInstanceOf(IllegalTransitionError);

    expect((await readStack(stackId)).status).toBe("running");
    expect(await auditFor(stackId)).toHaveLength(0);
  });

  it("refuses an expectedFrom that is not itself a legal source", async () => {
    const stackId = await seedStack("running");
    await expect(
      service.transition({
        stackId,
        to: "destroying",
        expectedFrom: "running",
      }),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
    expect((await readStack(stackId)).status).toBe("running");
  });

  it("honours a matching expectedFrom", async () => {
    const stackId = await seedStack("publishing");
    const stack = await service.transition({
      stackId,
      to: "running",
      expectedFrom: "publishing",
    });
    expect(stack.status).toBe("running");
  });

  it("clears last_error when leaving error, and keeps it otherwise", async () => {
    const recovering = await seedStack("error", {
      lastError: "boom",
      retryCount: 2,
    });
    const retried = await service.transition({
      stackId: recovering,
      to: "provisioning",
    });
    expect(retried.lastError).toBeNull();
    // The retry COUNT survives — it is the history of attempts, not the message.
    expect(retried.retryCount).toBe(2);

    // A transition that does not leave `error` must not touch the field.
    const failing = await seedStack("provisioning", { lastError: "stale" });
    const errored = await service.transition({ stackId: failing, to: "error" });
    expect(errored.lastError).toBe("stale");
  });

  it("resets retry_count on reaching running", async () => {
    const stackId = await seedStack("provisioning", { retryCount: 3 });
    const stack = await service.transition({ stackId, to: "running" });
    expect(stack.retryCount).toBe(0);
  });

  it("reports an unknown stack", async () => {
    await expect(
      service.transition({
        stackId: "00000000-0000-0000-0000-000000000000",
        to: "provisioning",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("lets exactly one of two concurrent transitions win", async () => {
    const stackId = await seedStack("requested");

    const results = await Promise.allSettled([
      service.transition({ stackId, to: "provisioning" }),
      service.transition({ stackId, to: "provisioning" }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      IllegalTransitionError,
    );

    expect((await readStack(stackId)).status).toBe("provisioning");
    // The loser wrote nothing at all — one transition, one audit row.
    expect(await auditFor(stackId)).toHaveLength(1);
  });
});

describe("StackService.recordError", () => {
  it("parks a provisioning stack in error with the message and a bumped count", async () => {
    const stackId = await seedStack("provisioning", { retryCount: 1 });
    const stack = await service.recordError({
      stackId,
      error: "railway 502",
      step: "create-service",
      actor: "provisioner",
    });

    expect(stack.status).toBe("error");
    expect(stack.lastError).toBe("railway 502");
    expect(stack.retryCount).toBe(2);

    const rows = await auditFor(stackId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("stack.error");
    expect(rows[0]?.detail).toMatchObject({
      from: "provisioning",
      to: "error",
      step: "create-service",
      error: "railway 502",
    });
  });

  it("accepts publishing and destroying as sources", async () => {
    for (const from of ["publishing", "destroying"] as const) {
      const stackId = await seedStack(from);
      const stack = await service.recordError({ stackId, error: "nope" });
      expect(stack.status).toBe("error");
    }
  });

  it("refuses a stack that cannot fail (running, destroyed, …)", async () => {
    for (const from of [
      "requested",
      "running",
      "suspended",
      "destroyed",
      "error",
    ] as const) {
      const stackId = await seedStack(from);
      await expect(
        service.recordError({ stackId, error: "nope" }),
      ).rejects.toBeInstanceOf(IllegalTransitionError);
      expect((await readStack(stackId)).status).toBe(from);
    }
  });

  it("truncates a runaway error message to 2000 characters", async () => {
    const stackId = await seedStack("provisioning");
    const stack = await service.recordError({
      stackId,
      error: "x".repeat(5000),
    });
    expect(stack.lastError).toHaveLength(2000);
  });

  it("accepts an Error instance", async () => {
    const stackId = await seedStack("provisioning");
    const stack = await service.recordError({
      stackId,
      error: new Error("thrown"),
    });
    expect(stack.lastError).toBe("thrown");
  });
});

describe("StackService reads", () => {
  it("gets a stack by id and by environment, and nulls for a miss", async () => {
    const stackId = await seedStack("running");
    const stack = await service.get({ stackId });
    expect(stack?.id).toBe(stackId);

    const byEnv = await service.getByEnvironment({
      environmentId: stack?.environmentId ?? "",
    });
    expect(byEnv?.id).toBe(stackId);

    expect(
      await service.get({ stackId: "00000000-0000-0000-0000-000000000000" }),
    ).toBeNull();
    expect(
      await service.getByEnvironment({
        environmentId: "00000000-0000-0000-0000-000000000000",
      }),
    ).toBeNull();
  });
});
