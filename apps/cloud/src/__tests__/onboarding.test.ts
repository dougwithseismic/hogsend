import { describe, expect, it } from "vitest";
import { buildOnboardingView } from "../lib/onboarding";

/**
 * The checklist's copy and its completion rule.
 *
 * The rule that matters is that a tick means the thing HAPPENED. Every step is
 * derived from a counter or a row in the control plane's own tables, so a step
 * can only be done because the database says so — and the panel must disappear
 * the moment they all are, or a finished customer keeps a setup guide forever.
 */

const NOTHING = {
  running: false,
  publishedBuilds: 0,
  events: 0,
  emails: 0,
};

describe("buildOnboardingView", () => {
  it("ticks nothing for a brand-new environment", () => {
    const view = buildOnboardingView(NOTHING);

    expect(view.complete).toBe(false);
    expect(view.steps.every((step) => !step.done)).toBe(true);
  });

  it("ticks each step from its own signal, independently", () => {
    const view = buildOnboardingView({
      running: true,
      publishedBuilds: 2,
      events: 0,
      emails: 0,
    });

    const done = view.steps.filter((step) => step.done).map((step) => step.id);
    expect(done).toEqual(["instance", "publish"]);
  });

  // Order is the order of work: an instance exists, then it runs your code,
  // then it sees traffic, then it reaches a person.
  it("keeps the steps in the order the work happens", () => {
    expect(buildOnboardingView(NOTHING).steps.map((step) => step.id)).toEqual([
      "instance",
      "publish",
      "event",
      "email",
    ]);
  });

  it("is complete only when every step is", () => {
    expect(
      buildOnboardingView({
        running: true,
        publishedBuilds: 1,
        events: 1,
        emails: 1,
      }).complete,
    ).toBe(true);

    // One short is not complete — the panel keeps rendering.
    expect(
      buildOnboardingView({
        running: true,
        publishedBuilds: 1,
        events: 1,
        emails: 0,
      }).complete,
    ).toBe(false);
  });

  // A single event is the whole signal. Anything higher would leave a customer
  // who genuinely sent one staring at an unticked box.
  it("treats one as enough for the counter-backed steps", () => {
    const view = buildOnboardingView({
      running: true,
      publishedBuilds: 1,
      events: 1,
      emails: 1,
    });
    expect(view.steps.find((step) => step.id === "event")?.done).toBe(true);
    expect(view.steps.find((step) => step.id === "email")?.done).toBe(true);
  });

  it("gives every unfinished step something to act on", () => {
    for (const step of buildOnboardingView(NOTHING).steps) {
      // The first step is the pipeline's job, not the customer's, so it is the
      // one step with nothing to do.
      if (step.id === "instance") continue;
      expect(step.hint ?? step.command).toBeTruthy();
    }
  });
});
