import { defineJourney, minutes } from "@hogsend/engine/journeys";
import { Events } from "./constants/index.js";

/**
 * A smoke-test journey for GROUP-scoped waits (companion to `test-onboarding`):
 * fire `test.group_wait` for one member of a company, then `test.group_done`
 * from ANY member of the same company — the wait resumes for the enrolled
 * user and `actorUserId` tells you who acted. No email, no external deps.
 *
 * The company key auto-resolves from the trigger event's `groups` association
 * (or the enrolled user's sole membership). The group type is compile-checked
 * against `src/groups.d.ts`. See README "Verify the pipeline".
 */
export const testGroupWait = defineJourney({
  meta: {
    id: "test-group-wait",
    name: "Test — Group-Scoped Wait",
    enabled: true,
    trigger: { event: Events.TEST_GROUP_WAIT },
    entryLimit: "unlimited",
    suppress: minutes(0),
  },

  run: async (user, ctx) => {
    const decision = await ctx.waitForEvent({
      event: Events.TEST_GROUP_DONE,
      group: "company",
      timeout: minutes(3),
      label: "group-decision",
    });

    await ctx.trigger({
      event: Events.TEST_GROUP_WAIT_RESULT,
      userId: user.id,
      properties: {
        timedOut: decision.timedOut,
        actor: decision.actorUserId ?? "",
        actedByTeammate: !decision.timedOut && decision.actorUserId !== user.id,
      },
    });
  },
});
