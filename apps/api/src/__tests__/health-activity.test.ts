import { createApp, createHogsendClient } from "@hogsend/engine";
import { describe, expect, it } from "vitest";

const container = createHogsendClient();
const app = createApp(container);

describe("GET /v1/health activity", () => {
  it("returns the activity section with journey and email counts", async () => {
    const res = await app.request("/v1/health");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.activity).toBeDefined();
    expect(body.activity.windowHours).toBe(24);
    expect(body.activity.journeys).toBeDefined();
    expect(body.activity.emails).toBeDefined();
  });

  it("reports counts when the DB is up, degrades to nulls when it is not", async () => {
    const res = await app.request("/v1/health");
    const body = await res.json();
    const { journeys, emails } = body.activity;
    const dbUp = body.components.database.status === "up";

    for (const value of [
      journeys.failed,
      journeys.completed,
      emails.failed,
      emails.sent,
    ]) {
      if (dbUp) {
        // Real counts against the test DB.
        expect(value).toBeTypeOf("number");
        expect(value).toBeGreaterThanOrEqual(0);
      } else {
        // Degrade-on-failure path: nulls, never a broken healthcheck.
        expect(value).toBeNull();
      }
    }
  });

  it("never breaks the health status shape", async () => {
    const res = await app.request("/v1/health");
    const body = await res.json();
    expect(["healthy", "degraded", "migration_pending"]).toContain(body.status);
    expect(body.components.database).toBeDefined();
  });
});
