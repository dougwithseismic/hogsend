import { minutes } from "@hogsend/core";
import { createJourneyTest } from "@hogsend/testing";
import { describe, expect, it } from "vitest";
import { Events } from "./constants/index.js";
import { testGroupWait } from "./test-group-wait.js";

/**
 * Simulated coverage for the group-scoped wait. The harness has no membership
 * database — the company key comes from the trigger's `groups` association
 * (`triggerGroups`), exactly like a live trigger event carrying
 * `groups: { company: "acme.dev" }`.
 */

const user = { id: "dev-1", email: "dev@acme.dev", properties: {} };

describe("test-group-wait journey", () => {
  it("resumes when a TEAMMATE emits the event and reports the actor", async () => {
    const test = createJourneyTest(testGroupWait, {
      user,
      triggerGroups: { company: "acme.dev" },
    });

    // Another company's event must NOT resume this wait…
    test.events.after(
      minutes(1),
      Events.TEST_GROUP_DONE,
      {},
      { userId: "rival-1", groups: { company: "other.io" } },
    );
    // …but a different member of the SAME company does.
    test.events.after(
      minutes(2),
      Events.TEST_GROUP_DONE,
      {},
      { userId: "cto-9", groups: { company: "acme.dev" } },
    );

    await test.run();

    expect(test.effects.triggers).toHaveLength(1);
    expect(test.effects.triggers[0]).toMatchObject({
      event: Events.TEST_GROUP_WAIT_RESULT,
      properties: { timedOut: false, actor: "cto-9", actedByTeammate: true },
    });
  });

  it("times out when nobody in the company acts", async () => {
    const test = createJourneyTest(testGroupWait, {
      user,
      triggerGroups: { company: "acme.dev" },
    });

    await test.run();

    expect(test.effects.triggers[0]).toMatchObject({
      event: Events.TEST_GROUP_WAIT_RESULT,
      properties: { timedOut: true, actedByTeammate: false },
    });
  });
});
