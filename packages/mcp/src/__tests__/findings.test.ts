import { describe, expect, it } from "vitest";
import {
  deadTriggerFindings,
  deliverabilityFindings,
  funnelFindings,
  parkedNodeFindings,
  readinessFindings,
  templateFindings,
} from "../lib/findings.js";
import { renderFindings, sortFindings } from "../lib/format.js";

describe("parkedNodeFindings", () => {
  const nodes = [
    { id: "start", type: "start", title: "Start" },
    { id: "await-score", type: "wait", title: "await-score" },
    { id: "send:hello", type: "send", title: "Send email" },
  ];

  it("flags a durable node holding >=20% of enrollments", () => {
    const f = parkedNodeFindings("j1", "Feedback NPS", {
      nodes,
      enrolled: 1000,
      nodeMetrics: { "await-score": { live: 412, failed: 0 } },
    });
    expect(f).toHaveLength(1);
    expect(f[0]?.severity).toBe("warning");
    expect(f[0]?.finding).toContain("412");
    expect(f[0]?.evidence.nodeId).toBe("await-score");
  });

  it("escalates to critical at >=50%", () => {
    const f = parkedNodeFindings("j1", "J", {
      nodes,
      enrolled: 100,
      nodeMetrics: { "await-score": { live: 60, failed: 0 } },
    });
    expect(f[0]?.severity).toBe("critical");
  });

  it("ignores instantaneous nodes and small counts", () => {
    const f = parkedNodeFindings("j1", "J", {
      nodes,
      enrolled: 100,
      nodeMetrics: {
        "send:hello": { live: 90, failed: 0 }, // send node: never parked
        "await-score": { live: 5, failed: 0 }, // below the absolute floor
      },
    });
    expect(f).toHaveLength(0);
  });

  it("flags failure hotspots at a node", () => {
    const f = parkedNodeFindings("j1", "J", {
      nodes,
      enrolled: 100,
      nodeMetrics: { "await-score": { live: 0, failed: 30 } },
    });
    expect(f).toHaveLength(1);
    expect(f[0]?.severity).toBe("critical"); // 30% failed
  });
});

describe("funnelFindings", () => {
  it("flags a bad send→open rate with enough volume", () => {
    const f = funnelFindings("j1", "Churn Prevention", {
      journeyId: "j1",
      enrolled: 500,
      emailSent: 400,
      emailOpened: 40, // 10% < 15% floor
      emailClicked: 5,
      completed: 100,
      failed: 0,
      exited: 0,
    });
    expect(f.some((x) => x.finding.includes("between send and open"))).toBe(
      true,
    );
  });

  it("stays silent under the volume floor", () => {
    const f = funnelFindings("j1", "J", {
      journeyId: "j1",
      enrolled: 5,
      emailSent: 5,
      emailOpened: 0,
      emailClicked: 0,
      completed: 0,
      failed: 0,
      exited: 0,
    });
    expect(f).toHaveLength(0);
  });
});

describe("deadTriggerFindings", () => {
  it("flags enabled journeys with zero enrollments only", () => {
    const f = deadTriggerFindings([
      {
        id: "dead",
        name: "Dead",
        enabled: true,
        trigger: { event: "never.fires" },
        counts: { active: 0, waiting: 0, completed: 0, failed: 0, exited: 0 },
      },
      {
        id: "alive",
        name: "Alive",
        enabled: true,
        trigger: { event: "x" },
        counts: { active: 1, waiting: 0, completed: 0, failed: 0, exited: 0 },
      },
      {
        id: "off",
        name: "Off",
        enabled: false,
        trigger: { event: "y" },
        counts: { active: 0, waiting: 0, completed: 0, failed: 0, exited: 0 },
      },
    ]);
    expect(f.map((x) => x.evidence.journeyId)).toEqual(["dead"]);
  });
});

describe("templateFindings", () => {
  it("ranks the worst open rates, volume-gated, max 3", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      templateKey: `t${i}`,
      sent: 100,
      delivered: 100,
      opened: i, // 0..4% open
      clicked: 0,
      bounced: 0,
      openRate: i,
      clickRate: 0,
    }));
    const f = templateFindings(rows);
    expect(f).toHaveLength(3);
    expect(f[0]?.evidence.templateKey).toBe("t0"); // worst first
  });
});

describe("deliverabilityFindings", () => {
  it("flags complaint rate over Gmail's ceiling as critical", () => {
    const f = deliverabilityFindings([
      { date: "d", total: 1000, delivered: 950, bounced: 10, complained: 4 },
    ]);
    const complaint = f.find((x) => x.finding.includes("Complaint"));
    expect(complaint?.severity).toBe("critical"); // 0.42% > 0.3%
  });

  it("silent under the volume floor", () => {
    expect(
      deliverabilityFindings([
        { date: "d", total: 10, delivered: 5, bounced: 5, complained: 1 },
      ]),
    ).toHaveLength(0);
  });
});

describe("readiness + rendering", () => {
  it("action checks become info findings; render ranks critical first", () => {
    const findings = [
      ...readinessFindings([
        { label: "Sending domain", status: "action" },
        { label: "Worker", status: "ok" },
      ]),
      ...deliverabilityFindings([
        { date: "d", total: 1000, delivered: 950, bounced: 10, complained: 4 },
      ]),
    ];
    const sorted = sortFindings(findings);
    expect(sorted[0]?.severity).toBe("critical");
    const text = renderFindings(findings);
    expect(text.startsWith("1. [CRITICAL]")).toBe(true);
  });
});
