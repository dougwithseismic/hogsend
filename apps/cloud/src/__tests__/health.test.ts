import { beforeAll, describe, expect, it } from "vitest";
import { GET } from "../../app/api/health/route";
import { checkCloudHealth } from "../db/health";
import { runCloudMigrations } from "../db/migrator";
import { env } from "../env";

// A port nothing listens on — the connection refuses fast, which is exactly
// the "database is down" shape the route must survive.
const DEAD_URL = "postgres://growthhog:growthhog@localhost:59999/hogsend_cloud";

describe("cloud health", () => {
  // Self-contained: vitest runs files in parallel, so this suite cannot assume
  // the migrate suite already created + migrated the database.
  beforeAll(async () => {
    await runCloudMigrations(env.CLOUD_DATABASE_URL);
  });

  it("reports ok against the real database", async () => {
    const report = await checkCloudHealth(env.CLOUD_DATABASE_URL);
    expect(report.db).toBe("ok");
    expect(report.migrations).toBe("in_sync");
    expect(report.status).toBe("ok");
  });

  it("reports degraded (but not a failure) when the database is unreachable", async () => {
    const report = await checkCloudHealth(DEAD_URL);
    expect(report.db).toBe("error");
    expect(report.migrations).toBe("pending");
    expect(report.status).toBe("degraded");
  });

  it("GET /api/health returns 200 with the report shape", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      status: expect.stringMatching(/^(ok|degraded)$/),
      db: expect.stringMatching(/^(ok|error)$/),
      migrations: expect.stringMatching(/^(in_sync|pending)$/),
    });
    // Never cached — a stale health body is worse than none.
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});
