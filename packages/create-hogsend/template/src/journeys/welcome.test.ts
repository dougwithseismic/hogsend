import { days } from "@hogsend/core";
import { createJourneyTest } from "@hogsend/testing";
import "@hogsend/testing/vitest";
import { describe, expect, it } from "vitest";
import { templates } from "../emails/registry.js";
import { Events, Templates } from "./constants/index.js";
import { welcome } from "./welcome.js";

describe("welcome journey", () => {
  it("does not nudge a user who activates during the wait", async () => {
    const test = createJourneyTest(welcome, {
      user: {
        id: "user-1",
        email: "dev@example.com",
        properties: { firstName: "Ada" },
      },
      templates,
    });
    test.events.after(days(1), Events.FEATURE_USED);

    await test.run();

    expect(test.mailbox).toHaveSent(Templates.ACTIVATION_WELCOME);
    expect(test.mailbox).not.toHaveSent(Templates.ACTIVATION_NUDGE);
  });
});
