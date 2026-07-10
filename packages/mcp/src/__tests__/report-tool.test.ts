/**
 * hogsend_report against a stub AdminClient — the scope dispatch + joins,
 * no network.
 */
import { describe, expect, it } from "vitest";
import type { AdminClient, Query } from "../client.js";
import { reportTool } from "../tools/report.js";

/** Route-table stub: path prefix → response (or thrower). */
function stubClient(routes: Record<string, unknown>): AdminClient {
  const lookup = (path: string): unknown => {
    if (path in routes) return routes[path];
    const hit = Object.keys(routes).find((k) => path.startsWith(k));
    if (hit) return routes[hit];
    const err = new Error(`404: no stub for ${path}`) as Error & {
      status: number;
    };
    err.status = 404;
    throw err;
  };
  return {
    baseUrl: "http://test.local",
    get: async <T>(path: string, _query?: Query) => lookup(path) as T,
    post: async <T>(path: string) => lookup(path) as T,
    put: async <T>(path: string) => lookup(path) as T,
    patch: async <T>(path: string) => lookup(path) as T,
  };
}

const journeyCounts = {
  active: 10,
  waiting: 400,
  completed: 500,
  failed: 50,
  exited: 40,
};

const baseRoutes = {
  "/v1/admin/metrics/overview": {
    totalContacts: 5000,
    activeJourneys: 1,
    emailsSent30d: 2000,
  },
  "/v1/admin/journeys": {
    journeys: [
      {
        id: "onboarding",
        name: "Onboarding",
        enabled: true,
        trigger: { event: "user.signed_up" },
        counts: journeyCounts,
      },
    ],
    total: 1,
  },
  "/v1/admin/journeys/onboarding/graph": {
    graph: {
      nodes: [
        { id: "start", type: "start", title: "Start" },
        { id: "wait-activated", type: "wait", title: "wait-activated" },
      ],
      edges: [],
    },
    metrics: {
      enrolled: 1000,
      terminals: { completed: 500, failed: 50, exited: 40 },
      nodes: { "wait-activated": { live: 400, failed: 0 } },
    },
  },
  "/v1/admin/journeys/onboarding": { journey: { id: "onboarding" } },
  "/v1/admin/metrics/journeys/onboarding": {
    journeyId: "onboarding",
    enrolled: 1000,
    emailSent: 900,
    emailOpened: 300,
    emailClicked: 50,
    completed: 500,
    failed: 50,
    exited: 40,
  },
  "/v1/admin/metrics/emails": { templates: [] },
  "/v1/admin/metrics/emails/deliverability": { points: [] },
  "/v1/admin/readiness": { checks: [] },
  "/v1/admin/templates": {
    templates: [{ key: "welcome", category: "onboarding" }],
  },
};

describe("hogsend_report", () => {
  it("health: finds the parked-node bottleneck in one call", async () => {
    const res = await reportTool.handler({}, stubClient(baseRoutes));
    expect(res.isError).toBeUndefined();
    const text = (res.content?.[0] as { text: string }).text;
    expect(text).toContain("parked");
    expect(text).toContain("wait-activated");
    const structured = res.structuredContent as { findings: unknown[] };
    expect(structured.findings.length).toBeGreaterThan(0);
  });

  it("journey: walkthrough + node table + funnel", async () => {
    const res = await reportTool.handler(
      { scope: "journey", id: "onboarding" },
      stubClient(baseRoutes),
    );
    const text = (res.content?.[0] as { text: string }).text;
    expect(text).toContain("Code-defined"); // journey-specs 404s in the stub
    expect(text).toContain("wait-activated | wait");
    expect(text).toContain("Funnel: enrolled 1000");
  });

  it("catalog: journeys + template keys", async () => {
    const res = await reportTool.handler(
      { scope: "catalog" },
      stubClient(baseRoutes),
    );
    const text = (res.content?.[0] as { text: string }).text;
    expect(text).toContain("onboarding");
    expect(text).toContain("welcome");
  });

  it("scope requiring id errors helpfully without one", async () => {
    const res = await reportTool.handler(
      { scope: "journey" },
      stubClient(baseRoutes),
    );
    expect(res.isError).toBe(true);
    expect((res.content?.[0] as { text: string }).text).toContain("requires");
  });
});
