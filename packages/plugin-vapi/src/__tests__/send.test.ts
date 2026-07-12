import { VoiceCallError } from "@hogsend/voice";
import { describe, expect, it, vi } from "vitest";
import type { VapiClient } from "../client.js";
import { startCall } from "../send.js";
import type { StartCallOptions } from "../types.js";

const options: StartCallOptions = {
  to: "+15551112222",
  agent: { systemPrompt: "You are a helpful assistant." },
  variables: { name: "Ada" },
  metadata: { voiceCallId: "vc_1" },
};

function fakeClient(impl: VapiClient["createCall"]): VapiClient {
  return { createCall: impl };
}

describe("startCall", () => {
  it("POSTs a transient assistant + customer + phoneNumberId + overrides", async () => {
    const createCall = vi.fn(async (body: unknown) => {
      const b = body as Record<string, unknown>;
      expect(b.phoneNumberId).toBe("pn_1");
      expect(b.customer).toEqual({ number: "+15551112222" });
      expect(b.assistantOverrides).toEqual({ variableValues: { name: "Ada" } });
      expect(b.metadata).toEqual({ voiceCallId: "vc_1" });
      const assistant = b.assistant as Record<string, unknown>;
      const model = assistant.model as Record<string, unknown>;
      expect((model.messages as unknown[])[0]).toEqual({
        role: "system",
        content: "You are a helpful assistant.",
      });
      expect(assistant.server).toEqual({ url: "https://x/vapi", secret: "s" });
      return { id: "call_123", status: "queued" };
    });

    const result = await startCall({
      client: fakeClient(createCall),
      options,
      phoneNumberId: "pn_1",
      server: { url: "https://x/vapi", secret: "s" },
    });
    expect(result).toEqual({ id: "call_123", status: "queued" });
    expect(createCall).toHaveBeenCalledOnce();
  });

  it("does not retry a permanent 4xx and surfaces a VoiceCallError", async () => {
    const createCall = vi.fn(async () => {
      const err = new Error("bad number") as Error & { status?: number };
      err.status = 400;
      throw err;
    });
    await expect(
      startCall({
        client: fakeClient(createCall),
        options,
        phoneNumberId: "pn",
      }),
    ).rejects.toBeInstanceOf(VoiceCallError);
    expect(createCall).toHaveBeenCalledOnce();
  });

  it("does NOT retry a 5xx (ambiguous — POST /call is non-idempotent, avoid double-dial)", async () => {
    const createCall = vi.fn(async () => {
      const err = new Error("upstream") as Error & { status?: number };
      err.status = 503;
      throw err;
    });
    await expect(
      startCall({
        client: fakeClient(createCall),
        options,
        phoneNumberId: "pn",
      }),
    ).rejects.toBeInstanceOf(VoiceCallError);
    expect(createCall).toHaveBeenCalledOnce();
  });

  it("retries a 429 (rejected before the call was placed) then succeeds", async () => {
    let calls = 0;
    const createCall = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error("rate limited") as Error & { status?: number };
        err.status = 429;
        throw err;
      }
      return { id: "call_ok" };
    });
    const result = await startCall({
      client: fakeClient(createCall),
      options,
      phoneNumberId: "pn",
      retryOptions: { baseDelayMs: 1, maxDelayMs: 2 },
    });
    expect(result.id).toBe("call_ok");
    expect(calls).toBe(2);
  });
});
