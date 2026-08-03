import { describe, expect, it } from "vitest";
import { runCloudMigrations } from "../db/migrator";
import { env } from "../env";

describe("cloud migrator", () => {
  it("is idempotent — a second run applies nothing", async () => {
    const first = await runCloudMigrations(env.CLOUD_DATABASE_URL);
    expect(first.inSync).toBe(true);

    const second = await runCloudMigrations(env.CLOUD_DATABASE_URL);
    expect(second.inSync).toBe(true);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toBe(
      first.alreadyApplied + first.applied.length,
    );
  });
});
