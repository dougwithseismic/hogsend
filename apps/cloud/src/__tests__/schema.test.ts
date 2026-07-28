import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import {
  cells,
  environments,
  organizations,
  stacks,
  usageCounters,
} from "../db/schema";
import { env } from "../env";

/**
 * Constraint tests against a REAL database — the point is to prove the
 * migration's indexes exist and bite, which a mocked driver cannot do.
 *
 * Fixtures are keyed off this prefix and deleted in `afterAll`, so the suite is
 * rerunnable and never collides with a parallel file. Deletes cascade from the
 * org, so removing the two roots removes everything below them.
 */
const PREFIX = "schema-test";
const ORG_ID = `${PREFIX}-org`;
const CELL_NAME = `${PREFIX}-cell`;

/** Narrow a `returning()`/`select()` result to its single row, loudly. */
function one<T>(rows: T[], what: string): T {
  const row = rows[0];
  if (!row) throw new Error(`expected exactly one ${what}, got none`);
  return row;
}

/**
 * Drizzle wraps driver errors in a generic "Failed query: …" Error, so the
 * Postgres code and the violated constraint only exist one level down on
 * `cause`. Asserting on the CONSTRAINT NAME (not merely "it threw") is what
 * makes these tests prove the specific index exists — a rejection for any other
 * reason fails here.
 */
async function expectUniqueViolation(
  run: () => Promise<unknown>,
  constraint: string,
): Promise<void> {
  try {
    await run();
  } catch (err) {
    const cause = (
      err as { cause?: { code?: string; constraint_name?: string } }
    ).cause;
    expect(cause?.code).toBe("23505");
    expect(cause?.constraint_name).toBe(constraint);
    return;
  }
  throw new Error(`expected a unique violation on ${constraint}, got success`);
}

async function cleanup(): Promise<void> {
  await db.delete(organizations).where(eq(organizations.id, ORG_ID));
  await db.delete(cells).where(eq(cells.name, CELL_NAME));
}

async function productionEnvironment() {
  return one(
    await db
      .select()
      .from(environments)
      .where(eq(environments.organizationId, ORG_ID))
      .limit(1),
    "environment",
  );
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
});

describe("cloud tenant schema", () => {
  it("round-trips a cell → org → environment → stack", async () => {
    const cell = one(
      await db
        .insert(cells)
        .values({
          name: CELL_NAME,
          region: "us",
          sharedClusterDsn: "ciphertext://not-a-real-dsn",
          sharedHatchetUrl: "grpc://hatchet.test:7077",
        })
        .returning(),
      "cell",
    );
    expect(cell.accepting).toBe(true);
    expect(cell.maxTenants).toBe(100);

    const org = one(
      await db
        .insert(organizations)
        .values({
          id: ORG_ID,
          name: "Schema Test Org",
          region: "us",
          cellId: cell.id,
        })
        .returning(),
      "organization",
    );
    // Plan defaults to the trial tier without the caller saying so.
    expect(org.plan).toBe("trial");
    expect(org.cellId).toBe(cell.id);

    const environment = one(
      await db
        .insert(environments)
        .values({
          organizationId: ORG_ID,
          name: "production",
          kind: "production",
        })
        .returning(),
      "environment",
    );
    expect(environment.kind).toBe("production");

    const stack = one(
      await db
        .insert(stacks)
        .values({
          organizationId: ORG_ID,
          environmentId: environment.id,
          region: "us",
          substrateRefs: { projectId: "opaque-123" },
        })
        .returning(),
      "stack",
    );
    expect(stack.status).toBe("requested");
    expect(stack.retryCount).toBe(0);
    expect(stack.substrateRefs).toEqual({ projectId: "opaque-123" });
  });

  it("rejects a second stack for the same environment (1:1)", async () => {
    const environment = await productionEnvironment();

    await expectUniqueViolation(
      () =>
        db.insert(stacks).values({
          organizationId: ORG_ID,
          environmentId: environment.id,
          region: "us",
        }),
      "stacks_environment_id_unique_idx",
    );
  });

  it("rejects a duplicate (organization_id, name) environment", async () => {
    await expectUniqueViolation(
      () =>
        db.insert(environments).values({
          organizationId: ORG_ID,
          name: "production",
          kind: "staging",
        }),
      "environments_org_name_unique_idx",
    );

    // The same NAME is what collides — a different name under the same org is
    // fine, proving the arbiter is the pair and not the org alone.
    const staging = one(
      await db
        .insert(environments)
        .values({ organizationId: ORG_ID, name: "staging", kind: "staging" })
        .returning(),
      "environment",
    );
    expect(staging.name).toBe("staging");
  });

  it("upsert-increments usage_counters on (environment_id, month)", async () => {
    const environment = await productionEnvironment();

    const bump = (events: number, emails: number) =>
      db
        .insert(usageCounters)
        .values({
          organizationId: ORG_ID,
          environmentId: environment.id,
          month: "2026-07",
          eventsCount: events,
          emailsCount: emails,
        })
        .onConflictDoUpdate({
          target: [usageCounters.environmentId, usageCounters.month],
          set: {
            eventsCount: sql`${usageCounters.eventsCount} + ${events}`,
            emailsCount: sql`${usageCounters.emailsCount} + ${emails}`,
            updatedAt: sql`now()`,
          },
        })
        .returning();

    const first = one(await bump(10, 1), "counter");
    expect(first.eventsCount).toBe(10);

    const second = one(await bump(5, 2), "counter");
    // Same row, accumulated — no read-first round trip, no lost update.
    expect(second.id).toBe(first.id);
    expect(second.eventsCount).toBe(15);
    expect(second.emailsCount).toBe(3);

    const rows = await db
      .select()
      .from(usageCounters)
      .where(eq(usageCounters.environmentId, environment.id));
    expect(rows).toHaveLength(1);
  });

  it("created every migration-0001 table in the cloud schema", async () => {
    const rows = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'cloud' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    expect([...rows].map((r) => r.table_name)).toEqual([
      "__cloud_migrations",
      "cells",
      "cloud_audit_log",
      "environments",
      "organizations",
      "provider_keys",
      "stacks",
      "usage_counters",
    ]);
  });
});
