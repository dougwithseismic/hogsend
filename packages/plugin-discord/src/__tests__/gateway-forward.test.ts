import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordEvents } from "../events.js";
import {
  type DiscordGatewayWorkerConfig,
  forwardDispatch,
} from "../gateway/worker.js";

/**
 * Unit-tests the dispatch→ingress mapping WITHOUT a live `discord.js` socket:
 * a fake poster is injected (the same seam `start()` calls on every raw packet),
 * so we assert the pre-filter, the args handed to ingress, and the never-throws
 * contract independently of the WebSocket loop.
 */
const config: DiscordGatewayWorkerConfig = {
  botToken: "Bot fake-token",
  apiPublicUrl: "https://tunnel.example.com",
  ingressSecret: "x".repeat(32),
};

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  vi.restoreAllMocks();
});

describe("forwardDispatch", () => {
  it("forwards a mapped dispatch with the exact ingress args", async () => {
    const poster = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const d = { id: "1", author: { id: "u1" } };

    await forwardDispatch(config, { t: "MESSAGE_CREATE", d }, poster);

    expect(poster).toHaveBeenCalledTimes(1);
    expect(poster).toHaveBeenCalledWith({
      apiPublicUrl: config.apiPublicUrl,
      ingressSecret: config.ingressSecret,
      dispatchType: "MESSAGE_CREATE",
      data: d,
    });
  });

  it("forwards every mapped Discord dispatch type", async () => {
    const poster = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    for (const t of Object.keys(DiscordEvents)) {
      await forwardDispatch(config, { t, d: { probe: t } }, poster);
    }
    expect(poster).toHaveBeenCalledTimes(Object.keys(DiscordEvents).length);
    for (const t of Object.keys(DiscordEvents)) {
      expect(poster).toHaveBeenCalledWith(
        expect.objectContaining({ dispatchType: t }),
      );
    }
  });

  it("skips an unmapped dispatch type (cheap pre-filter, no POST)", async () => {
    const poster = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await forwardDispatch(config, { t: "TYPING_START", d: {} }, poster);
    expect(poster).not.toHaveBeenCalled();
  });

  it("skips a frame with no dispatch type (op-only / heartbeat ack)", async () => {
    const poster = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await forwardDispatch(config, { t: null, d: undefined }, poster);
    await forwardDispatch(config, {}, poster);
    expect(poster).not.toHaveBeenCalled();
  });

  it("logs a non-2xx ingress response but does not throw", async () => {
    const poster = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    await expect(
      forwardDispatch(config, { t: "MESSAGE_CREATE", d: {} }, poster),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("non-2xx (401)"),
    );
  });

  it("swallows a thrown poster error (socket stays up)", async () => {
    const poster = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(
      forwardDispatch(config, { t: "GUILD_MEMBER_ADD", d: {} }, poster),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      "discord ingress forward failed",
      expect.any(Error),
    );
  });
});
