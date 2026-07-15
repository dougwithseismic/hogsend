import {
  createMemoize,
  type JourneyBoundary,
  type JourneyEmailEffect,
  runWithJourneyBoundary,
  sendEmail,
} from "@hogsend/engine";
import { describe, expect, it, vi } from "vitest";

function boundaryWithClock(
  now: () => Date,
  capture: (effect: JourneyEmailEffect) => void,
): JourneyBoundary {
  return {
    stateId: "state-clock",
    runAnchor: "run-clock",
    currentLabel: undefined,
    seenKeys: new Set<string>(),
    seenRecordLabels: new Set<string>(),
    memoize: createMemoize({}),
    now,
    services: {
      email: async (effect) => {
        capture(effect);
        return {
          emailSendId: "send-clock",
          sentAt: "2026-07-14T09:00:00.987Z",
        };
      },
    },
  };
}

describe("journey boundary clock", () => {
  it("uses the scoped clock for unsubscribe-token expiry", async () => {
    const fixedNow = new Date("2026-07-14T09:00:00.987Z");
    const now = vi.fn(() => new Date(fixedNow));
    let captured: JourneyEmailEffect | undefined;

    await runWithJourneyBoundary(
      boundaryWithClock(now, (effect) => {
        captured = effect;
      }),
      () =>
        sendEmail({
          to: "dev@acme.com",
          userId: "u1",
          template: "welcome",
          subject: "Welcome",
        }),
    );

    const unsubscribeUrl = captured?.props.unsubscribeUrl;
    expect(unsubscribeUrl).toEqual(expect.any(String));
    const token = new URL(unsubscribeUrl as string).searchParams.get(
      "token",
    ) as string;
    const [encodedPayload] = token.split(".");
    const payload = JSON.parse(
      Buffer.from(encodedPayload as string, "base64url").toString("utf8"),
    ) as { exp: number };

    expect(payload.exp).toBe(
      Math.floor(fixedNow.getTime() / 1000) + 30 * 24 * 3600,
    );
    expect(now).toHaveBeenCalledOnce();
  });
});
