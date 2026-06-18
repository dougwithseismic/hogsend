import { createApp, createHogsendClient } from "@hogsend/engine";
import { describe, expect, it } from "vitest";

/**
 * Contract guard for the Hogsend desktop companion (`apps/desktop`).
 *
 * The menubar poller (`apps/desktop/src-tauri/src/lib.rs`) and its TypeScript
 * mirror (`apps/desktop/src/lib/types.ts`) read a fixed set of keys out of
 * `GET /v1/health`, and the Studio auto-login (also in `lib.rs`) posts to two
 * Better Auth routes. None of that is bundled from the engine — it's a hand-
 * mirrored copy of this server contract, so a rename here drifts silently.
 *
 * If one of these assertions fails, the engine moved a key the companion
 * depends on. Update BOTH ends of the desktop app (the Rust JSON pointers and
 * the TS types) in the same change, then fix the assertion here.
 */

const container = createHogsendClient();
const app = createApp(container);

describe("GET /v1/health — desktop companion contract", () => {
  it("exposes every field the menubar poller reads", async () => {
    const res = await app.request("/v1/health");
    expect(res.status).toBe(200);
    const body = await res.json();

    // Tray glyph + header (tray_title / tray_tooltip, HealthDashboard header).
    expect(["healthy", "degraded", "migration_pending"]).toContain(body.status);
    expect(body.version).toBeTypeOf("string");
    expect(body.uptime).toBeTypeOf("number");

    // Component rows (HealthDashboard ComponentRow). worker.status also feeds
    // the "worker went offline" notification.
    expect(["up", "down"]).toContain(body.components.database.status);
    expect(["up", "down"]).toContain(body.components.redis.status);
    expect(["up", "down"]).toContain(body.components.worker.status);

    // 24h activity (the four Metric tiles + the failure-count notifications).
    // Numbers when the DB is up; null when health degrades them — the poller
    // tolerates both, so the contract is "present, and number-or-null".
    expect(body.activity.windowHours).toBeTypeOf("number");
    for (const value of [
      body.activity.emails.sent,
      body.activity.emails.failed,
      body.activity.journeys.completed,
      body.activity.journeys.failed,
    ]) {
      expect(value === null || typeof value === "number").toBe(true);
    }

    // Schema tracks drive the "pending migrations" banner.
    for (const track of [body.schema.engine, body.schema.client]) {
      expect(track.inSync).toBeTypeOf("boolean");
      expect(Array.isArray(track.pending)).toBe(true);
    }
  });
});

describe("Better Auth — desktop auto-login contract", () => {
  // The Studio auto-login script checks the session, then signs in. We only
  // assert the routes are still MOUNTED (not 404) — the exact request/response
  // shapes are Better Auth's, stable across versions, and not ours to pin.
  it("session lookup route is mounted", async () => {
    const res = await app.request("/api/auth/get-session", {
      headers: { accept: "application/json" },
    });
    expect(res.status).not.toBe(404);
  });

  it("email sign-in route is mounted", async () => {
    const res = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).not.toBe(404);
  });
});
