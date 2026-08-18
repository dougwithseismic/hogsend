import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `CLOUD_PROVISION_ON=first-publish`'s second half (PRD 15): the publish is
 * what asks for the substrate.
 *
 * The laws under test, none of which a mock would certify:
 *  - the promotion is a GUARDED edge, so two publishes racing a first upload
 *    promote once and enqueue once — asserted by driving both concurrently
 *    against the real row rather than by reasoning about the SQL;
 *  - a stack in any other status is left alone, `running` included: the intake
 *    calls this unconditionally and the module decides;
 *  - the intake really does accept the build afterwards. A promotion that
 *    worked but refused the upload would be worse than no promotion at all.
 *
 * The artifacts root is repointed BEFORE `src/env.ts` is imported, so the suite
 * never writes into the repository.
 */
const ARTIFACTS_ROOT = mkdtempSync(join(tmpdir(), "hogsend-deferred-"));
process.env.CLOUD_ARTIFACTS_DIR = ARTIFACTS_ROOT;

const { eq, inArray } = await import("drizzle-orm");
const { POST: publishRoute } = await import(
  "../../app/api/publish/[environmentId]/route"
);
const { GET: buildRoute } = await import(
  "../../app/api/builds/[buildId]/route"
);
const { db, sqlClient } = await import("../db");
const { runCloudMigrations } = await import("../db/migrator");
const { builds, environments, organizations, stacks } = await import(
  "../db/schema"
);
const { env } = await import("../env");
const { promoteDeferredStack } = await import("../lib/deferred-stacks");
const { PublishTokenService } = await import("../services/publish-tokens");
const { StackService } = await import("../services/stacks");

const ORG = "deferred-provision-test-org";
const tokens = new PublishTokenService(db);
const stackService = new StackService(db);

let seq = 0;

/** What a promoted stack may be found in — see the publish case below. */
const PROMOTED_STATUSES = ["requested", "provisioning"];

/** An environment whose stack is born `deferred`, plus its publish token. */
async function seedDeferred(
  status: "deferred" | "running" = "deferred",
): Promise<{ environmentId: string; stackId: string; token: string }> {
  seq += 1;
  const [environment] = await db
    .insert(environments)
    .values({
      organizationId: ORG,
      name: `deferred-env-${seq}`,
      kind: "test",
    })
    .returning();
  if (!environment) throw new Error("failed to seed environment");

  const [stack] = await db
    .insert(stacks)
    .values({
      organizationId: ORG,
      environmentId: environment.id,
      region: "us",
      status,
      dbName: `deferred_db_${seq}`,
    })
    .returning();
  if (!stack) throw new Error("failed to seed stack");

  const { token } = await tokens.mint({ environmentId: environment.id });
  return { environmentId: environment.id, stackId: stack.id, token };
}

function gzipBytes(size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes[0] = 0x1f;
  bytes[1] = 0x8b;
  return bytes;
}

function uploadRequest(environmentId: string, token: string): Request {
  const form = new FormData();
  form.set("manifest", JSON.stringify({ engineVersion: "0.57.0" }));
  form.set(
    "tarball",
    new File([gzipBytes() as BlobPart], "app.tar.gz", {
      type: "application/gzip",
    }),
  );
  return new Request(`http://localhost:3004/api/publish/${environmentId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
}

async function statusOf(stackId: string): Promise<string> {
  const [row] = await db
    .select({ status: stacks.status })
    .from(stacks)
    .where(eq(stacks.id, stackId));
  return row?.status ?? "missing";
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await db
    .insert(organizations)
    .values({ id: ORG, name: "Deferred Provision Test", region: "us" })
    .onConflictDoNothing();
});

afterAll(async () => {
  const envIds = (
    await db
      .select({ id: environments.id })
      .from(environments)
      .where(eq(environments.organizationId, ORG))
  ).map((row) => row.id);
  if (envIds.length > 0) {
    await db.delete(builds).where(inArray(builds.environmentId, envIds));
    await db.delete(stacks).where(inArray(stacks.environmentId, envIds));
    await db.delete(environments).where(inArray(environments.id, envIds));
  }
  await db.delete(organizations).where(eq(organizations.id, ORG));
  await sqlClient.end({ timeout: 5 });
});

describe("promoteDeferredStack", () => {
  it("promotes deferred → requested and enqueues exactly once", async () => {
    const fixture = await seedDeferred();
    const enqueued: string[] = [];

    const result = await promoteDeferredStack(
      { environmentId: fixture.environmentId },
      {
        stackService,
        enqueueProvision: async (stackId) => {
          enqueued.push(stackId);
        },
      },
    );

    expect(result.promoted).toBe(true);
    expect(result.stackId).toBe(fixture.stackId);
    expect(await statusOf(fixture.stackId)).toBe("requested");
    expect(enqueued).toEqual([fixture.stackId]);
  });

  it("promotes ONCE when two publishes race the same first upload", async () => {
    const fixture = await seedDeferred();
    const enqueued: string[] = [];
    const promote = () =>
      promoteDeferredStack(
        { environmentId: fixture.environmentId },
        {
          stackService,
          enqueueProvision: async (stackId) => {
            enqueued.push(stackId);
          },
        },
      );

    // Both read `deferred`; only one may take the edge. The guard is the
    // UPDATE's `WHERE status = 'deferred'`, so this is decided by Postgres
    // rather than by whichever call happened to read first.
    const [first, second] = await Promise.all([promote(), promote()]);

    const promotions = [first, second].filter((r) => r.promoted);
    expect(promotions).toHaveLength(1);
    // And exactly one enqueue: the loser must not hand the same stack to the
    // provisioner a second time.
    expect(enqueued).toEqual([fixture.stackId]);
    expect(await statusOf(fixture.stackId)).toBe("requested");
  });

  it("leaves a stack that is not deferred completely alone", async () => {
    const fixture = await seedDeferred("running");
    const enqueued: string[] = [];

    const result = await promoteDeferredStack(
      { environmentId: fixture.environmentId },
      {
        stackService,
        enqueueProvision: async (stackId) => {
          enqueued.push(stackId);
        },
      },
    );

    expect(result.promoted).toBe(false);
    expect(result.from).toBe("running");
    expect(enqueued).toEqual([]);
    expect(await statusOf(fixture.stackId)).toBe("running");
  });
});

describe("POST /api/publish/:environmentId", () => {
  it("promotes the deferred stack AND accepts the build", async () => {
    const fixture = await seedDeferred();

    // HOLD the inline provisioner at its first substrate call. The real
    // `enqueueProvision` runs (that is the point — the intake really enqueues),
    // but this fixture is not provisionable end to end, so left ungated the
    // pipeline can run to `error` before the assertions read the row — a
    // scheduling race CI actually lost (run 30998979320) while three local
    // passes won it. Gated, the stack is deterministically in
    // `requested`/`provisioning` at read time under ANY scheduling, and the
    // gate is released before the assertions so nothing leaks past the test.
    const { configureProvisioning, resetProvisioning } = await import(
      "../pipeline/enqueue"
    );
    const { FakeSubstrate } = await import("../substrate/fake");
    let releaseGate = (): void => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const gated = new FakeSubstrate();
    const realProvision = gated.provisionStack.bind(gated);
    gated.provisionStack = async (spec) => {
      await gate;
      return realProvision(spec);
    };
    // The substrate call is NOT the first thing that can fail: `start` and
    // `ensure-tenant-db` run before it, and this fixture (an org with no cell)
    // throws in the latter, parking the stack in `error` on a slow runner
    // before the assertions read the row (runs 32137333490, 32139059866 lost
    // that race; local passes win it). Gate the pipeline's FIRST write, the
    // `start` transition, so the row is deterministically `requested` at read
    // time under any scheduling.
    const { StackService } = await import("../services/stacks");
    const gatedStacks = new StackService();
    const realTransition = gatedStacks.transition.bind(gatedStacks);
    gatedStacks.transition = async (...args) => {
      await gate;
      return realTransition(...args);
    };
    configureProvisioning({ substrate: gated, stackService: gatedStacks });

    try {
      const response = await publishRoute(
        uploadRequest(fixture.environmentId, fixture.token),
        { params: Promise.resolve({ environmentId: fixture.environmentId }) },
      );

      // The upload is accepted exactly as it always was — promotion is a thing
      // the intake does FOR the caller, not a new way to refuse them.
      expect(response.status).toBe(202);
      const body = (await response.json()) as {
        buildId: string;
        status: string;
      };
      expect(body.status).toBe("queued");
      // Promoted OUT of `deferred`, and no further: the gate above pins the
      // in-process provisioner before it can park the fixture in `error`.
      expect(PROMOTED_STATUSES).toContain(await statusOf(fixture.stackId));

      // And the status endpoint carries the stack's phase, which is the only
      // thing the CLI can render while the build waits for substrate.
      const status = await buildRoute(
        new Request(`http://localhost:3004/api/builds/${body.buildId}`, {
          headers: { authorization: `Bearer ${fixture.token}` },
        }),
        { params: Promise.resolve({ buildId: body.buildId }) },
      );
      expect(status.status).toBe(200);
      const view = (await status.json()) as {
        status: string;
        stack: { status: string } | null;
      };
      expect(view.status).toBe("queued");
      // The pair the CLI narrates from: a queued build, and a stack that is
      // being built. Without this field there is nothing to render for the
      // minutes a first publish spends waiting for substrate.
      expect(PROMOTED_STATUSES).toContain(view.stack?.status);
    } finally {
      releaseGate();
      resetProvisioning();
    }
  });
});
