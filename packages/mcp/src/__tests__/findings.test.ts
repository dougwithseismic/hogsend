/**
 * The pure findings heuristics — boundary behavior for each threshold, so a
 * change to a cutoff is caught. Fixed clock, fixture payloads, no I/O.
 */
import { describe, expect, it } from "vitest";
import {
  type BlueprintListItem,
  type DeliverabilityPoint,
  deadBlueprintTriggerFindings,
  deadJourneyTriggerFindings,
  deliverabilityFindings,
  type FunnelEntry,
  funnelFindings,
  type JourneyListItem,
  type JourneyMetric,
  readinessFindings,
} from "../lib/findings.js";

const NOW = new Date("2026-07-11T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const zeroCounts = {
  active: 0,
  waiting: 0,
  completed: 0,
  failed: 0,
  exited: 0,
};

function bp(overrides: Partial<BlueprintListItem>): BlueprintListItem {
  return {
    id: "bp",
    name: "BP",
    status: "enabled",
    triggerEvent: "some_event",
    updatedAt: new Date(NOW.getTime() - 30 * DAY).toISOString(),
    promotedAt: null,
    counts: { ...zeroCounts },
    ...overrides,
  };
}

describe("readinessFindings", () => {
  it("turns only action items into findings, escalating the critical ones", () => {
    const findings = readinessFindings({
      checks: [
        {
          id: "studio_admin",
          label: "Studio admin",
          status: "ok",
          detail: "ok",
        },
        {
          id: "email_provider",
          label: "Email provider",
          status: "action",
          detail: "no key",
          docsUrl: "https://docs.hogsend.com",
        },
        {
          id: "sending_domain",
          label: "Sending domain",
          status: "action",
          detail: "unverified",
        },
        {
          id: "analytics",
          label: "PostHog analytics",
          status: "optional",
          detail: "optional",
        },
      ],
    });

    expect(findings).toHaveLength(2);
    const email = findings.find((f) => f.id === "readiness:email_provider");
    const domain = findings.find((f) => f.id === "readiness:sending_domain");
    expect(email?.severity).toBe("critical");
    expect(email?.suggested_action).toContain("docs.hogsend.com");
    expect(domain?.severity).toBe("warning");
  });
});

describe("deadBlueprintTriggerFindings", () => {
  it("flags an enabled, long-unchanged, never-enrolled blueprint", () => {
    const findings = deadBlueprintTriggerFindings(
      [
        bp({
          id: "dead",
          updatedAt: new Date(NOW.getTime() - 10 * DAY).toISOString(),
        }),
      ],
      NOW,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("dead-blueprint:dead");
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.evidence).toContain("unchanged since");
  });

  it("does NOT flag a recently-enabled blueprint (updatedAt age gate)", () => {
    // A 30-day-old draft enabled 2 days ago has a fresh updatedAt → not dead.
    const findings = deadBlueprintTriggerFindings(
      [bp({ updatedAt: new Date(NOW.getTime() - 2 * DAY).toISOString() })],
      NOW,
    );
    expect(findings).toHaveLength(0);
  });

  it("does NOT flag when it has enrolled anyone", () => {
    const findings = deadBlueprintTriggerFindings(
      [bp({ counts: { ...zeroCounts, completed: 1 } })],
      NOW,
    );
    expect(findings).toHaveLength(0);
  });

  it("ignores draft and promoted blueprints", () => {
    const findings = deadBlueprintTriggerFindings(
      [
        bp({ id: "draft", status: "draft" }),
        bp({ id: "promoted", promotedAt: NOW.toISOString() }),
      ],
      NOW,
    );
    expect(findings).toHaveLength(0);
  });
});

describe("deadJourneyTriggerFindings", () => {
  const journeys: JourneyListItem[] = [
    {
      id: "j-live",
      name: "Live",
      enabled: true,
      trigger: { event: "e1" },
      counts: { ...zeroCounts },
    },
    {
      id: "j-dead",
      name: "Dead",
      enabled: true,
      trigger: { event: "e2" },
      counts: { ...zeroCounts },
    },
    {
      id: "j-off",
      name: "Off",
      enabled: false,
      trigger: { event: "e3" },
      counts: { ...zeroCounts },
    },
  ];
  const metrics: JourneyMetric[] = [
    { journeyId: "j-live", enrolled: 42 },
    { journeyId: "j-dead", enrolled: 0 },
  ];

  it("flags only the enabled journey with zero enrollments", () => {
    const findings = deadJourneyTriggerFindings(journeys, metrics);
    expect(findings.map((f) => f.id)).toEqual(["dead-journey:j-dead"]);
  });

  it("falls back to list counts when a metric row is missing", () => {
    const findings = deadJourneyTriggerFindings(
      [
        {
          id: "j",
          name: "J",
          enabled: true,
          trigger: { event: "e" },
          counts: { ...zeroCounts, active: 3 },
        },
      ],
      [],
    );
    expect(findings).toHaveLength(0);
  });
});

describe("funnelFindings", () => {
  const entry = (o: Partial<FunnelEntry>): FunnelEntry => ({
    id: "x",
    label: "x",
    sent: 0,
    opened: 0,
    clicked: 0,
    ...o,
  });

  it("flags a low open rate at/over the sample floor but under 10%", () => {
    // 4/50 = 8% → warning.
    expect(funnelFindings([entry({ sent: 50, opened: 4 })])).toHaveLength(1);
  });

  it("does not flag exactly 10% open rate", () => {
    // 5/50 = 10% is not < 10%.
    const findings = funnelFindings([entry({ sent: 50, opened: 5 })]);
    expect(findings.some((f) => f.id.startsWith("funnel-open"))).toBe(false);
  });

  it("does not flag below the send sample floor", () => {
    // 0/49 opens but only 49 sends.
    expect(funnelFindings([entry({ sent: 49, opened: 0 })])).toHaveLength(0);
  });

  it("flags zero clicks once opens reach the floor (info)", () => {
    const findings = funnelFindings([
      entry({ sent: 200, opened: 50, clicked: 0 }),
    ]);
    const click = findings.find((f) => f.id.startsWith("funnel-click"));
    expect(click?.severity).toBe("info");
  });

  it("does not flag zero clicks below the open floor", () => {
    const findings = funnelFindings([
      entry({ sent: 200, opened: 49, clicked: 0 }),
    ]);
    expect(findings.some((f) => f.id.startsWith("funnel-click"))).toBe(false);
  });
});

describe("deliverabilityFindings", () => {
  const point = (o: Partial<DeliverabilityPoint>): DeliverabilityPoint => ({
    date: "2026-07-01",
    total: 0,
    delivered: 0,
    bounced: 0,
    complained: 0,
    ...o,
  });

  it("returns nothing below the volume floor", () => {
    expect(
      deliverabilityFindings([point({ total: 50, delivered: 10 })]),
    ).toHaveLength(0);
  });

  it("is silent on a healthy sender", () => {
    expect(
      deliverabilityFindings([
        point({ total: 1000, delivered: 980, bounced: 5, complained: 0 }),
      ]),
    ).toHaveLength(0);
  });

  it("flags bounce (warning), complaint (critical), and delivery (warning) together", () => {
    // 6% bounce (warn), 0.6% complaint (crit), 85% delivery (warn).
    const findings = deliverabilityFindings([
      point({ total: 1000, delivered: 850, bounced: 60, complained: 6 }),
    ]);
    const byId = new Map(findings.map((f) => [f.id, f.severity]));
    expect(byId.get("deliverability:bounce")).toBe("warning");
    expect(byId.get("deliverability:complaint")).toBe("critical");
    expect(byId.get("deliverability:delivery")).toBe("warning");
  });

  it("escalates bounce to critical past 10%", () => {
    const findings = deliverabilityFindings([
      point({ total: 1000, delivered: 870, bounced: 120, complained: 0 }),
    ]);
    expect(
      findings.find((f) => f.id === "deliverability:bounce")?.severity,
    ).toBe("critical");
  });
});
