/**
 * `hogsend_report` — scope dispatch, the identity envelope, and that a route
 * failure comes back as a structured result (never a throw).
 */
import { describe, expect, it } from "vitest";
import { createReportTool } from "../tools/report.js";
import { httpError, makeClient } from "./helpers.js";

const IDENTITY = {
  actor: "api-key",
  id: "k1",
  name: "test-key",
  scopes: ["full-admin"],
};

describe("hogsend_report", () => {
  it("catalog: returns templates + event names, no findings, with identity", async () => {
    const { client } = makeClient({
      get: ({ path }) => {
        if (path === "/v1/admin/api-keys/self") return IDENTITY;
        if (path === "/v1/admin/templates")
          return { templates: [{ key: "welcome", defaultSubject: "Hi" }] };
        if (path === "/v1/admin/events/names")
          return {
            note: "open vocab",
            events: [{ name: "signed_up", occurrences: 3 }],
          };
        throw httpError(404, { error: `unexpected ${path}` });
      },
    });
    const tool = createReportTool(client);

    const result = (await tool.handler({ scope: "catalog" })) as {
      ok: boolean;
      scope: string;
      generatedFor: unknown;
      findings: unknown[];
      catalog: { templates: unknown[]; eventNames: unknown[] };
    };

    expect(result.ok).toBe(true);
    expect(result.scope).toBe("catalog");
    expect(result.generatedFor).toEqual(IDENTITY);
    expect(result.findings).toEqual([]);
    expect(result.catalog.templates).toHaveLength(1);
    expect(result.catalog.eventNames).toHaveLength(1);
  });

  it("health: surfaces readiness action items as findings", async () => {
    const { client } = makeClient({
      get: ({ path }) => {
        if (path === "/v1/admin/api-keys/self") return IDENTITY;
        if (path === "/v1/admin/readiness")
          return {
            checks: [
              {
                id: "email_provider",
                label: "Email provider",
                status: "action",
                detail: "no key",
              },
              {
                id: "studio_admin",
                label: "Studio admin",
                status: "ok",
                detail: "ok",
              },
            ],
          };
        throw httpError(404, { error: `unexpected ${path}` });
      },
    });
    const tool = createReportTool(client);

    const result = (await tool.handler({ scope: "health" })) as {
      ok: boolean;
      findings: { id: string; severity: string }[];
    };

    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.severity).toBe("critical");
  });

  it("blueprints: flags a dead trigger from the list route", async () => {
    const { client } = makeClient({
      get: ({ path }) => {
        if (path === "/v1/admin/api-keys/self") return IDENTITY;
        if (path === "/v1/admin/blueprints")
          return {
            total: 1,
            blueprints: [
              {
                id: "stale",
                name: "Stale",
                status: "enabled",
                triggerEvent: "never_fires",
                updatedAt: "2020-01-01T00:00:00.000Z",
                promotedAt: null,
                counts: {
                  active: 0,
                  waiting: 0,
                  completed: 0,
                  failed: 0,
                  exited: 0,
                },
              },
            ],
          };
        throw httpError(404, { error: `unexpected ${path}` });
      },
    });
    const tool = createReportTool(client);

    const result = (await tool.handler({ scope: "blueprints" })) as {
      ok: boolean;
      findings: { id: string }[];
    };

    expect(result.ok).toBe(true);
    expect(result.findings[0]?.id).toBe("dead-blueprint:stale");
  });

  it("returns a structured unauthorized result when identity 401s", async () => {
    const { client } = makeClient({
      get: () => {
        throw httpError(401, { error: "Unauthorized" });
      },
    });
    const tool = createReportTool(client);

    const result = (await tool.handler({ scope: "health" })) as {
      ok: boolean;
      code: string;
    };

    expect(result.ok).toBe(false);
    expect(result.code).toBe("unauthorized");
  });
});
