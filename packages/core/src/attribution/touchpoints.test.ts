import { describe, expect, it } from "vitest";
import {
  isTouchpointEvent,
  TOUCHPOINT_EVENT_CLASSES,
  TOUCHPOINT_EVENTS,
  touchpointChannel,
} from "./touchpoints.js";

describe("touchpoint classification", () => {
  it("classifies the built-in touchpoint events by channel", () => {
    expect(touchpointChannel("campaign.arrived")).toBe("campaign");
    expect(touchpointChannel("link.clicked")).toBe("link");
    expect(touchpointChannel("link.arrived")).toBe("link");
    expect(touchpointChannel("email.link_clicked")).toBe("email");
    expect(touchpointChannel("email.action")).toBe("email");
    expect(touchpointChannel("sms.link_clicked")).toBe("sms");
    expect(touchpointChannel("lead.submitted")).toBe("form");
  });

  it("excludes non-touch events — opens are deliberately NOT touchpoints", () => {
    expect(touchpointChannel("email.opened")).toBeNull();
    expect(isTouchpointEvent("email.opened")).toBe(false);
    expect(isTouchpointEvent("order.completed")).toBe(false);
  });

  it("lets extras add classes and win name collisions", () => {
    const extra = [
      { event: "call.answered", channel: "form" as const },
      { event: "email.action", channel: "campaign" as const },
    ];
    expect(touchpointChannel("call.answered", extra)).toBe("form");
    expect(touchpointChannel("email.action", extra)).toBe("campaign");
  });

  it("keeps TOUCHPOINT_EVENTS aligned with the class list", () => {
    expect(TOUCHPOINT_EVENTS).toEqual(
      TOUCHPOINT_EVENT_CLASSES.map((c) => c.event),
    );
    expect(new Set(TOUCHPOINT_EVENTS).size).toBe(TOUCHPOINT_EVENTS.length);
  });
});
