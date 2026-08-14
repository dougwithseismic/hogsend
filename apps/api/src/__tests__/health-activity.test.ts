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

  it("reports each activity count as a non-negative integer or null", async () => {
    // NOTE: this case used to branch on `components.database.status === "up"`
    // and demand numbers whenever the DB pinged up. That coupling does not
    // exist and the route deliberately refuses to provide it — see the comment
    // at packages/engine/src/routes/health.ts:95-99. The counts degrade to
    // NULL_ACTIVITY by TWO paths, neither of which consults the component
    // check:
    //   1. health.ts:107-114 — getRecentActivity races the query against
    //      ACTIVITY_TIMEOUT_MS (1500ms), so a slow report degrades rather than
    //      stalling the probe.
    //   2. health.ts:148-150 — queryRecentActivity swallows ANY throw and
    //      returns nulls, so a reporting hiccup can't take health down.
    // Path 2 is what this suite actually hits: vitest.config.ts points
    // DATABASE_URL at a placeholder that answers `SELECT 1` (component "up",
    // ~19ms) but has none of the hogsend tables, so both COUNT queries error
    // and every count comes back null. "database up + counts null" is the
    // DESIGNED outcome, not a bug.
    // The real contract is a shape contract, asserted below. Do not "tighten"
    // this back into a cross-field coupling; both branches are pinned
    // deterministically by the two injected cases that follow.
    const res = await app.request("/v1/health");
    const body = await res.json();
    const { journeys, emails } = body.activity;

    for (const value of [
      journeys.failed,
      journeys.completed,
      emails.failed,
      emails.sent,
    ]) {
      if (value === null) continue;
      expect(value).toBeTypeOf("number");
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  // The two cases below drive the route's success and degradation branches
  // directly rather than depending on what the ambient test DB happens to do.
  // `select` is the ONLY db call the activity query makes — the component ping
  // and both schema-version reads go through `db.execute` — so swapping just
  // `select` isolates queryRecentActivity while the rest of the handler runs
  // for real. The container is shallow-copied (the health handler reads only
  // `db` and `clientJournal` off it), so no second pool is opened.
  function appWithSelect(select: () => unknown) {
    const db = new Proxy(container.db, {
      get(target, prop, receiver) {
        if (prop === "select") return select;
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof container.db;
    return createApp({ ...container, db });
  }

  it("reports numeric counts when the activity query succeeds", async () => {
    // Postgres returns count(*) as a bigint string; the route coerces with
    // Number(), so this pins "numbers out" rather than "whatever pg gave us".
    let call = 0;
    const rows = [
      [{ failed: "2", completed: "5" }],
      // `sent` omitted on purpose — pins the `?? 0` fallback as a 0, not undefined.
      [{ failed: "0" }],
    ];
    const okApp = appWithSelect(() => ({
      from: () => ({ where: async () => rows[call++] }),
    }));

    const res = await okApp.request("/v1/health");
    expect(res.status).toBe(200);
    const { journeys, emails } = (await res.json()).activity;

    for (const value of [
      journeys.failed,
      journeys.completed,
      emails.failed,
      emails.sent,
    ]) {
      expect(value).toBeTypeOf("number");
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(journeys.failed).toBe(2);
    expect(journeys.completed).toBe(5);
    expect(emails.failed).toBe(0);
    expect(emails.sent).toBe(0);
  });

  it("degrades every count to null when the activity query throws", async () => {
    // Drives the degradation branch directly instead of hoping to observe it.
    // Deleting the `catch` at health.ts:148-150 makes this case fail with a
    // 500 — verified, so it is not a vacuous green.
    const degradedApp = appWithSelect(() => {
      throw new Error("activity query exploded");
    });
    const res = await degradedApp.request("/v1/health");

    // A reporting failure must NOT break the healthcheck.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(["healthy", "degraded", "migration_pending"]).toContain(body.status);

    expect(body.activity.windowHours).toBe(24);
    expect(body.activity.journeys.failed).toBeNull();
    expect(body.activity.journeys.completed).toBeNull();
    expect(body.activity.emails.failed).toBeNull();
    expect(body.activity.emails.sent).toBeNull();
  });

  it("never breaks the health status shape", async () => {
    const res = await app.request("/v1/health");
    const body = await res.json();
    expect(["healthy", "degraded", "migration_pending"]).toContain(body.status);
    expect(body.components.database).toBeDefined();
  });
});
