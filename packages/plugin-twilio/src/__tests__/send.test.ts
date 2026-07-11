import { SmsSendError } from "@hogsend/sms";
import type { Twilio } from "twilio";
import { describe, expect, it, vi } from "vitest";
import { sendSms } from "../send.js";

function fakeClient(
  create: (opts: Record<string, unknown>) => Promise<{ sid: string }>,
): Twilio {
  return { messages: { create } } as unknown as Twilio;
}

describe("sendSms", () => {
  it("wires a pinned `from` number", async () => {
    const create = vi.fn().mockResolvedValue({ sid: "SM1" });
    const result = await sendSms({
      client: fakeClient(create),
      options: { to: "+15551230000", body: "hi" },
      from: "+15559990000",
    });
    expect(result).toEqual({ id: "SM1" });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "+15551230000",
        body: "hi",
        from: "+15559990000",
      }),
    );
  });

  it("wires a messagingServiceSid when no from is set", async () => {
    const create = vi.fn().mockResolvedValue({ sid: "SM2" });
    await sendSms({
      client: fakeClient(create),
      options: { to: "+1", body: "hi" },
      messagingServiceSid: "MG123",
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ messagingServiceSid: "MG123" }),
    );
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("from");
  });

  it("lets an explicit options.from override the pinned from", async () => {
    const create = vi.fn().mockResolvedValue({ sid: "SM3" });
    await sendSms({
      client: fakeClient(create),
      options: { to: "+1", body: "hi", from: "+15550001111" },
      from: "+15559990000",
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ from: "+15550001111" }),
    );
  });

  it("attaches a statusCallback when provided", async () => {
    const create = vi.fn().mockResolvedValue({ sid: "SM4" });
    await sendSms({
      client: fakeClient(create),
      options: { to: "+1", body: "hi" },
      from: "+2",
      statusCallback: "https://x/y",
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ statusCallback: "https://x/y" }),
    );
  });

  it("does not retry a permanent Twilio error code", async () => {
    const err = Object.assign(new Error("invalid to"), {
      code: 21211,
      status: 400,
    });
    const create = vi.fn().mockRejectedValue(err);
    await expect(
      sendSms({
        client: fakeClient(create),
        options: { to: "+1", body: "hi" },
        from: "+2",
        retryOptions: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2 },
      }),
    ).rejects.toBeInstanceOf(SmsSendError);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("retries a transient (429) error then succeeds", async () => {
    const err = Object.assign(new Error("rate"), { status: 429 });
    const create = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue({ sid: "SM5" });
    const result = await sendSms({
      client: fakeClient(create),
      options: { to: "+1", body: "hi" },
      from: "+2",
      retryOptions: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2 },
    });
    expect(result).toEqual({ id: "SM5" });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("throws when neither from nor messagingServiceSid is available", async () => {
    const create = vi.fn();
    await expect(
      sendSms({
        client: fakeClient(create),
        options: { to: "+1", body: "hi" },
      }),
    ).rejects.toThrow(/requires a `from`/);
    expect(create).not.toHaveBeenCalled();
  });
});
