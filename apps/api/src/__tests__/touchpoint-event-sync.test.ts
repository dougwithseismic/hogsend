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
