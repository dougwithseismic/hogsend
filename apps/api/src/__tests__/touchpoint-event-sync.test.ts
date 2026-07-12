import { TOUCHPOINT_EVENTS } from "@hogsend/core";
import { describe, expect, it } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Core re-declares touchpoint event names as string literals (it cannot import
// the engine). This pins the hand-sync: if an engine tracking event is renamed,
// this fails before the attribution engine silently stops seeing that channel.
const { EMAIL_LINK_CLICKED, LINK_ARRIVED, LINK_CLICKED, SMS_LINK_CLICKED } =
  await import("@hogsend/engine");

describe("touchpoint classifier ↔ engine tracking event names", () => {
  it("every engine first-party click/arrival event is a classified touchpoint", () => {
    for (const name of [
      EMAIL_LINK_CLICKED,
      LINK_ARRIVED,
      LINK_CLICKED,
      SMS_LINK_CLICKED,
    ]) {
      expect(TOUCHPOINT_EVENTS).toContain(name);
    }
  });
});

describe("click-ID allowlist ↔ @hogsend/js copy", () => {
  it("core CLICK_ID_PARAM_NAMES and js CLICK_ID_PARAMS are identical (hand-synced)", async () => {
    const { CLICK_ID_PARAM_NAMES } = await import("@hogsend/core");
    const { CLICK_ID_PARAMS } = await import("@hogsend/js");
    expect([...CLICK_ID_PARAM_NAMES]).toEqual([...CLICK_ID_PARAMS]);
  });
});
