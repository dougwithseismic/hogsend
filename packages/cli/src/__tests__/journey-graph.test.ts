import { describe, expect, it } from "vitest";
import { extractJourneyGraph, extractJourneyId } from "../lib/journey-graph.js";

/** A sequential journey with sleeps, a branch, and an early return. */
const CHURN_SOURCE = `
import { days, hours } from "@hogsend/core/graph";
import { defineJourney, sendEmail } from "@hogsend/engine";

export const churnPrevention = defineJourney({
  meta: {
    id: "churn-prevention",
    name: "Churn",
    enabled: true,
    trigger: { event: Events.PAYMENT_FAILED },
    entryLimit: "once_per_period",
    entryPeriod: days(7),
    suppress: hours(4),
    exitOn: [
      { event: Events.PAYMENT_SUCCEEDED },
      { event: Events.SUBSCRIPTION_CANCELLED },
    ],
  },
  run: async (user, ctx) => {
    await sendEmail({
      to: user.email,
      template: Templates.CHURN_PAYMENT_FAILED,
      subject: "Your payment didn't go through",
    });
    await ctx.sleep({ duration: days(1), label: "first-retry" });
    const { found: hasRetried } = await ctx.history.hasEvent({
      userId: user.id,
      event: Events.PAYMENT_SUCCEEDED,
      within: days(1),
    });
    if (hasRetried) return;
    await sendEmail({
      template: Templates.CHURN_PAYMENT_FAILED,
      subject: "Reminder: please update your payment method",
    });
    await ctx.sleep({ duration: days(2), label: "final-notice" });
    const { found: hasResolved } = await ctx.history.hasEvent({
      userId: user.id,
      event: Events.PAYMENT_SUCCEEDED,
      within: days(3),
    });
    if (!hasResolved) {
      await sendEmail({
        template: Templates.CHURN_PAYMENT_FAILED,
        subject: "Final notice",
      });
    }
  },
});
`;

/** A journey with waitForEvent, checkpoint, and a trigger. */
const NPS_SOURCE = `
import { days } from "@hogsend/core/graph";
import { defineJourney, sendEmail } from "@hogsend/engine";

export const feedbackNps = defineJourney({
  meta: {
    id: "feedback-nps",
    name: "NPS",
    enabled: true,
    trigger: { event: Events.USER_CREATED },
    entryLimit: "once",
    suppress: days(1),
    exitOn: [{ event: Events.USER_DELETED }],
  },
  run: async (user, ctx) => {
    await ctx.sleep({ duration: days(14), label: "day-14" });
    await sendEmail({ subject: "Quick question", template: Templates.NPS });
    const answer = await ctx.waitForEvent({
      event: Events.NPS_SUBMITTED,
      timeout: days(3),
      label: "await-score",
    });
    if (answer.timedOut) return;
    await ctx.checkpoint("scored");
    await ctx.trigger({ event: Events.NPS_DETRACTOR, userId: user.id });
  },
});
`;

describe("extractJourneyId", () => {
  it("parses the meta id from a journey file", () => {
    const id = extractJourneyIdFromSource(CHURN_SOURCE);
    expect(id).toBe("churn-prevention");
  });

  it("returns undefined when there is no defineJourney", () => {
    expect(extractJourneyIdFromSource("export const x = 1;")).toBeUndefined();
  });
});

describe("extractJourneyGraph", () => {
  it("throws when no defineJourney call is present", () => {
    expect(() => extractFromSource("export const x = 1;")).toThrow(
      /no defineJourney/,
    );
  });

  it("falls back to a metadata-level graph when run is missing or unresolvable", () => {
    // No `run` at all -> metadata fallback (trigger + body placeholder), no throw.
    const g = extractFromSource(
      "export const j = defineJourney({ meta: { id: 'x', name: 'x', enabled: true, trigger: { event: 'e' }, entryLimit: 'once', suppress: { hours: 1 } } });",
    );
    expect(g.journeyId).toBe("x");
    const kinds = g.nodes.map((n) => n.kind);
    expect(kinds).toContain("trigger");
    expect(kinds).toContain("checkpoint"); // body placeholder
    expect(g.disclaimer).toMatch(
      /referenced function|references an imported function/,
    );
  });

  it("resolves a referenced same-file run function (run: someFn)", () => {
    const g = extractFromSource(`
      import { defineJourney, sendEmail } from "@hogsend/engine";
      export const j = defineJourney({
        meta: { id: "ref", name: "ref", enabled: true, trigger: { event: "e" }, entryLimit: "once", suppress: { hours: 1 } },
        run: runIt,
      });
      async function runIt(user, ctx) {
        await sendEmail({ subject: "hi", template: "t" });
        await ctx.sleep({ duration: { hours: 1 }, label: "wait" });
      }
    `);
    const kinds = g.nodes.map((n) => n.kind);
    expect(kinds).toContain("email"); // the send inside runIt is visible
    expect(kinds).toContain("sleep");
  });

  it("extracts the churn-prevention graph: trigger, 3 emails, 2 sleeps, 2 branches, exits", () => {
    const g = extractFromSource(CHURN_SOURCE);
    expect(g.sourceLevel).toBe("rich");
    expect(g.journeyId).toBe("churn-prevention");

    const kinds = g.nodes.map((n) => n.kind);
    // 1 trigger + 3 emails + 2 sleeps + 2 branches + 1 shared end + 2 exits
    expect(kinds.filter((k) => k === "trigger")).toHaveLength(1);
    expect(kinds.filter((k) => k === "email")).toHaveLength(3);
    expect(kinds.filter((k) => k === "sleep")).toHaveLength(2);
    expect(kinds.filter((k) => k === "branch")).toHaveLength(2);
    // WS-2.5: all returns flow into ONE shared end node (was N ends for N returns).
    expect(kinds.filter((k) => k === "end")).toHaveLength(1);
    expect(kinds.filter((k) => k === "exit")).toHaveLength(2);

    // Trigger node carries the event name and countKey "start" (the engine's
    // initial currentNodeId — homes counts for users before any checkpoint).
    const trigger = g.nodes.find((n) => n.kind === "trigger");
    expect(trigger?.label).toBe("Events.PAYMENT_FAILED");
    expect(trigger?.countKey).toBe("start");

    // Emails carry the subject line.
    const emails = g.nodes.filter((n) => n.kind === "email");
    expect(emails[0]?.label).toBe("Your payment didn't go through");
    expect(emails[1]?.label).toBe(
      "Reminder: please update your payment method",
    );

    // Email nodes preserve the authored template ref. Here there's no
    // constants module on disk beside the temp fixture, so `Templates.X`
    // stays UNRESOLVED — templateKey is undefined (honest), templateRef kept.
    expect(emails[0]?.templateRef).toBe("Templates.CHURN_PAYMENT_FAILED");
    expect(emails[0]?.templateKey).toBeUndefined();

    // Sleeps do NOT carry a countKey — the engine never writes currentNodeId
    // for a sleep, so a badge would never have data.
    const sleeps = g.nodes.filter((n) => n.kind === "sleep");
    expect(sleeps[0]?.countKey).toBeUndefined();

    // Branches are labelled with their condition text.
    const branches = g.nodes.filter((n) => n.kind === "branch");
    expect(branches[0]?.label).toContain("hasRetried");
    expect(branches[1]?.label).toContain("hasResolved");

    // Exit nodes carry the exitOn event names.
    const exits = g.nodes.filter((n) => n.kind === "exit");
    expect(exits.map((n) => n.label)).toEqual(
      expect.arrayContaining([
        "Events.PAYMENT_SUCCEEDED",
        "Events.SUBSCRIPTION_CANCELLED",
      ]),
    );

    // Branches emit a "yes" edge into their consequent. (No-else branches fall
    // through unlabeled on the "no" path.)
    expect(g.edges.some((e) => e.label === "yes")).toBe(true);
    const duplicateEdges = g.edges.filter((edge, index) =>
      g.edges.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          other.from === edge.from &&
          other.to === edge.to &&
          other.kind === edge.kind &&
          other.label === edge.label,
      ),
    );
    expect(duplicateEdges).toHaveLength(0);
    for (const branch of branches) {
      const outgoing = g.edges.filter((edge) => edge.from === branch.id);
      for (const edge of outgoing) {
        expect(outgoing.filter((other) => other.to === edge.to).length).toBe(1);
      }
    }
  });

  it("extracts the feedback-nps graph: wait, checkpoint, trigger-event", () => {
    const g = extractFromSource(NPS_SOURCE);
    expect(g.journeyId).toBe("feedback-nps");

    const kinds = g.nodes.map((n) => n.kind);
    expect(kinds).toContain("wait");
    expect(kinds).toContain("checkpoint");
    expect(kinds).toContain("trigger-event");

    const wait = g.nodes.find((n) => n.kind === "wait");
    expect(wait?.label).toBe("await-score");
    expect(wait?.detail).toContain("timeout");
    // Wait countKey mirrors the engine: when a label is present it IS the key.
    expect(wait?.countKey).toBe("await-score");

    const checkpoint = g.nodes.find((n) => n.kind === "checkpoint");
    expect(checkpoint?.countKey).toBe("scored");

    const triggerEvent = g.nodes.find((n) => n.kind === "trigger-event");
    expect(triggerEvent?.label).toBe("Events.NPS_DETRACTOR");
  });

  it("sets wait countKey to wait-event:<event> when no label is given (mirrors engine)", () => {
    const g = extractFromSource(`
      import { defineJourney } from "@hogsend/engine";
      import { days } from "@hogsend/core/graph";
      export const j = defineJourney({
        meta: { id: "w", name: "w", enabled: true, trigger: { event: "e" }, entryLimit: "once", suppress: days(1) },
        run: async (user, ctx) => {
          await ctx.waitForEvent({ event: "nps.submitted", timeout: days(3) });
        },
      });
    `);
    const wait = g.nodes.find((n) => n.kind === "wait");
    // No label in source -> engine writes `wait-event:nps.submitted`; the
    // extractor must match so counts join.
    expect(wait?.countKey).toBe("wait-event:nps.submitted");
    expect(wait?.label).toBe("nps.submitted");
  });

  it("walks a for-loop body once and notes the simplification", () => {
    // Loops are now handled (WS-2.2): the send inside is visible, and a note
    // explains the loop-back isn't modeled.
    const g = extractFromSource(`
      import { defineJourney, sendEmail } from "@hogsend/engine";
      export const j = defineJourney({
        meta: { id: "dyn", trigger: { event: "e" }, entryLimit: "once", suppress: { hours: 1 }, enabled: true, name: "d" },
        run: async (user, ctx) => {
          for (const x of items) {
            await sendEmail({ template: "t", subject: "s" });
          }
        },
      });
    `);
    expect(g.nodes.some((n) => n.kind === "email")).toBe(true);
    expect(g.disclaimer).toContain("Loop body shown once");
  });

  it("records a disclaimer when an unrecognized statement is skipped", () => {
    // A throw statement (not a return) is genuinely unhandled -> skipped.
    const g = extractFromSource(`
      import { defineJourney } from "@hogsend/engine";
      export const j = defineJourney({
        meta: { id: "dyn", trigger: { event: "e" }, entryLimit: "once", suppress: { hours: 1 }, enabled: true, name: "d" },
        run: async (user, ctx) => {
          throw new Error("oops");
        },
      });
    `);
    expect(g.disclaimer).toContain("Best-effort");
    expect(g.disclaimer).toContain("skipped");
  });

  it("recognizes ctx.when.* as a schedule node", () => {
    const g = extractFromSource(`
      import { defineJourney } from "@hogsend/engine";
      import { days } from "@hogsend/core/graph";
      export const j = defineJourney({
        meta: { id: "sched", trigger: { event: "e" }, entryLimit: "once", suppress: days(1), enabled: true, name: "s" },
        run: async (user, ctx) => {
          await ctx.when.at("09:00").tz("America/New_York")();
        },
      });
    `);
    const schedule = g.nodes.find((n) => n.kind === "schedule");
    expect(schedule).toBeDefined();
    expect(schedule?.detail).toContain("ctx.when");
  });

  it("models a switch as a branch and walks its case bodies", () => {
    const g = extractFromSource(`
      import { defineJourney, sendEmail } from "@hogsend/engine";
      export const j = defineJourney({
        meta: { id: "sw", trigger: { event: "e" }, entryLimit: "once", suppress: { hours: 1 }, enabled: true, name: "s" },
        run: async (user, ctx) => {
          switch (user.properties.plan) {
            case "pro": { await sendEmail({ subject: "pro", template: "t" }); break; }
            case "free": { await sendEmail({ subject: "free", template: "t" }); break; }
          }
        },
      });
    `);
    expect(
      g.nodes.some((n) => n.kind === "branch" && n.label.startsWith("switch")),
    ).toBe(true);
    // Both case-body sends are visible.
    expect(g.nodes.filter((n) => n.kind === "email")).toHaveLength(2);
  });

  it("is deterministic: same source yields identical graph node ids", () => {
    const a = extractFromSource(CHURN_SOURCE);
    const b = extractFromSource(CHURN_SOURCE);
    expect(a.nodes.map((n) => n.id)).toEqual(b.nodes.map((n) => n.id));
    expect(a.edges).toEqual(b.edges);
  });
});

describe("email template ref resolution", () => {
  it("resolves a bare string-literal template to itself", () => {
    const src = `
      import { defineJourney, sendEmail } from "@hogsend/engine";
      export const j = defineJourney({
        meta: { id: "lit", name: "Lit", enabled: true, trigger: { event: "x" }, entryLimit: "once" },
        run: async (user, ctx) => {
          await sendEmail({ subject: "Hi", template: "welcome-key" });
        },
      });
    `;
    const g = extractFromSource(src);
    const email = g.nodes.find((n) => n.kind === "email");
    expect(email?.templateRef).toBe("welcome-key");
    expect(email?.templateKey).toBe("welcome-key");
  });

  it("resolves Templates.X through a re-exporting constants barrel", () => {
    const dir = mkdtempSync(join(tmpdir(), "journey-tmpl-"));
    try {
      const constants = join(dir, "constants");
      mkdirSync(constants, { recursive: true });
      // barrel re-exports from the concrete module (mirrors apps/api layout).
      writeFileSync(
        join(constants, "index.ts"),
        `export { Templates } from "./templates.js";\n`,
        "utf8",
      );
      writeFileSync(
        join(constants, "templates.ts"),
        `export const Templates = { WELCOME: "welcome", CHURN: "churn-payment-failed" } as const;\n`,
        "utf8",
      );
      const journey = join(dir, "welcome.ts");
      writeFileSync(
        journey,
        `
        import { defineJourney, sendEmail } from "@hogsend/engine";
        import { Templates } from "./constants/index.js";
        export const j = defineJourney({
          meta: { id: "welcome", name: "W", enabled: true, trigger: { event: "x" }, entryLimit: "once" },
          run: async (user, ctx) => {
            await sendEmail({ subject: "Hi", template: Templates.WELCOME });
            await sendEmail({ subject: "Bye", template: Templates.CHURN });
          },
        });
        `,
        "utf8",
      );
      const g = extractJourneyGraph(journey);
      const emails = g.nodes.filter((n) => n.kind === "email");
      expect(emails[0]?.templateRef).toBe("Templates.WELCOME");
      expect(emails[0]?.templateKey).toBe("welcome");
      expect(emails[1]?.templateRef).toBe("Templates.CHURN");
      expect(emails[1]?.templateKey).toBe("churn-payment-failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves through `as const satisfies Record<...>` (the dogfood shape)", () => {
    const dir = mkdtempSync(join(tmpdir(), "journey-tmpl-sat-"));
    try {
      const constants = join(dir, "constants");
      mkdirSync(constants, { recursive: true });
      writeFileSync(
        join(constants, "index.ts"),
        `export const Templates = {
          WELCOME: "welcome",
        } as const satisfies Record<string, string>;\n`,
        "utf8",
      );
      const journey = join(dir, "j.ts");
      writeFileSync(
        journey,
        `
        import { defineJourney, sendEmail } from "@hogsend/engine";
        import { Templates } from "./constants/index.js";
        export const j = defineJourney({
          meta: { id: "sat", name: "S", enabled: true, trigger: { event: "x" }, entryLimit: "once" },
          run: async (user, ctx) => {
            await sendEmail({ subject: "Hi", template: Templates.WELCOME });
          },
        });
        `,
        "utf8",
      );
      const g = extractJourneyGraph(journey);
      const email = g.nodes.find((n) => n.kind === "email");
      expect(email?.templateKey).toBe("welcome");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves a dynamic template ref unresolved (honest undefined)", () => {
    const src = `
      import { defineJourney, sendEmail } from "@hogsend/engine";
      export const j = defineJourney({
        meta: { id: "dyn", name: "Dyn", enabled: true, trigger: { event: "x" }, entryLimit: "once" },
        run: async (user, ctx) => {
          const key = pick();
          await sendEmail({ subject: "Hi", template: key });
        },
      });
    `;
    const g = extractFromSource(src);
    const email = g.nodes.find((n) => n.kind === "email");
    expect(email?.templateRef).toBe("key");
    expect(email?.templateKey).toBeUndefined();
  });
});

// ---- helpers: feed source text into the file-based API via a temp file ----

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
function withTempSource(source: string, fn: (path: string) => void) {
  tmpDir = mkdtempSync(join(tmpdir(), "journey-graph-"));
  try {
    const p = join(tmpDir, "journey.ts");
    writeFileSync(p, source, "utf8");
    fn(p);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function extractFromSource(source: string) {
  let result: ReturnType<typeof extractJourneyGraph> | undefined;
  withTempSource(source, (p) => {
    result = extractJourneyGraph(p);
  });
  // withTempSource runs fn synchronously, so result is always set here.
  return result as ReturnType<typeof extractJourneyGraph>;
}

function extractJourneyIdFromSource(source: string): string | undefined {
  let result: string | undefined;
  withTempSource(source, (p) => {
    result = extractJourneyId(p);
  });
  return result;
}
