import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editInteractionResponse } from "../connect/interactions-followup.js";

/**
 * Covers the 404-race retry in {@link editInteractionResponse} (commit 43fb4f4):
 * the deferred (type-5) ack is delivered by the engine route AFTER the handler
 * returns, so a fast follow-up can reach Discord BEFORE the deferral registers
 * and the `@original` message 404s. The retry loop re-PATCHes ONLY on 404 (short
 * backoff, MAX_ATTEMPTS=5); any other status fails fast.
 *
 * Fake timers keep the `setTimeout` backoff from actually sleeping —
 * `vi.runAllTimersAsync()` drains the pending sleep so the loop advances
 * synchronously to the test.
 */

const baseArgs = {
  applicationId: "app1",
  token: "interaction-token",
  body: { content: "done" },
};

function jsonResponse(status: number): Response {
  return new Response(status === 200 ? "{}" : "err", { status });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("editInteractionResponse 404-race retry", () => {
  it("(a) retries a 404 then resolves on the following 200", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(404))
      .mockResolvedValueOnce(jsonResponse(200));

    const promise = editInteractionResponse(baseArgs);
    // Drain the backoff sleep between attempt 1 (404) and attempt 2 (200).
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // No bot token / Authorization header — interaction-webhook endpoint only.
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(
      (init?.headers as Record<string, string>).Authorization,
    ).toBeUndefined();
  });

  it("(b) throws after MAX_ATTEMPTS (5) on a persistent 404", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(404));

    const promise = editInteractionResponse(baseArgs);
    // Surface the eventual rejection without an unhandled-rejection warning
    // while the timers are still being drained.
    const settled = promise.then(
      () => ({ ok: true }) as const,
      (err: unknown) => ({ ok: false, err }) as const,
    );
    await vi.runAllTimersAsync();
    const outcome = await settled;

    expect(outcome.ok).toBe(false);
    expect((outcome as { err: Error }).err).toBeInstanceOf(Error);
    expect((outcome as { err: Error }).err.message).toContain("(404)");
    // 5 attempts total — the 5th does not sleep/retry, it throws.
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });

  it("(c) throws IMMEDIATELY on a 401 with no retry", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(401));

    await expect(editInteractionResponse(baseArgs)).rejects.toThrow("(401)");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("(c) throws IMMEDIATELY on a 500 with no retry", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(500));

    await expect(editInteractionResponse(baseArgs)).rejects.toThrow("(500)");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
