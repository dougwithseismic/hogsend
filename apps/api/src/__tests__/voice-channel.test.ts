import { defineVoiceProvider, type VoiceWebhookParsed } from "@hogsend/core";
import { voiceCalls } from "@hogsend/db";
import {
  createApp,
  createHogsendClient,
  defineWebhookSource,
  synthesizeChannelLists,
} from "@hogsend/engine";
import { createVoiceToolRegistry, defineVoiceTool } from "@hogsend/voice";
import { beforeAll, describe, expect, it } from "vitest";

// A minimal fake voice provider so the container resolves an active provider
// without Vapi credentials in the test env. `verifyWebhook` branches on a test
// header so one provider drives every route case.
const fakeProvider = defineVoiceProvider({
  meta: { id: "fake-voice", name: "Fake Voice" },
  capabilities: { outboundCalls: true, midCallTools: true },
  async startCall() {
    return { id: "call_fake", status: "queued" };
  },
  verifyWebhook(opts): VoiceWebhookParsed {
    if (opts.headers["x-test-kind"] === "tool") {
      return {
        kind: "tool_call",
        calls: [
          {
            callId: "call_fake",
            toolCallId: "t1",
            name: "echo",
            args: { v: 1 },
          },
        ],
      };
    }
    // Otherwise reject — the route maps a throw to 401 (verification failed).
    throw new Error("bad signature");
  },
  parseWebhook(): VoiceWebhookParsed {
    return {
      kind: "event",
      event: {
        type: "voice.call_ended",
        callId: "call_fake",
        phone: "+15551230000",
        occurredAt: new Date(0).toISOString(),
        raw: {},
      },
    };
  },
  encodeToolResults(results) {
    return { results };
  },
});

const echoTool = defineVoiceTool({
  spec: { name: "echo", parameters: { type: "object", properties: {} } },
  handler: (args: { v: number }) => args,
});

describe("synthesizeChannelLists — voice channel", () => {
  it("mints a voice channel when configured — OPT-IN polarity (express consent)", () => {
    const channels = synthesizeChannelLists([], { voice: true });
    expect(channels.find((c) => c.id === "voice")).toEqual({
      id: "voice",
      name: "Voice",
      // TCPA prior express WRITTEN consent — the strictest channel.
      defaultOptIn: false,
      enabled: true,
      kind: "channel",
    });
  });

  it("omits the voice channel when not configured", () => {
    expect(
      synthesizeChannelLists([]).find((c) => c.id === "voice"),
    ).toBeUndefined();
  });
});

describe("voice provider registry + webhook route", () => {
  const container = createHogsendClient({
    voice: {
      provider: fakeProvider,
      // Empty registry — this app augments VoiceAgentRegistryMap with
      // "appointment-setter", so an empty literal needs a cast.
      // biome-ignore lint/suspicious/noExplicitAny: minimal test registry
      agents: {} as any,
      tools: createVoiceToolRegistry([echoTool]),
    },
  });
  const app = createApp(container, {});

  // The hardened tool dispatcher only runs a tool for a KNOWN call whose agent
  // declared it — insert the call row it will resolve + authorize against. Tolerate
  // a missing Postgres (CI without a DB): the tool-call test guards on `dbUp`.
  let dbUp = false;
  beforeAll(async () => {
    try {
      await container.db
        .insert(voiceCalls)
        .values({
          providerId: "fake-voice",
          providerCallId: "call_fake",
          agentKey: "test-agent",
          toNumber: "+15551112222",
          status: "ringing",
          metadata: { allowedTools: ["echo"] },
        })
        .onConflictDoNothing();
      dbUp = true;
    } catch {
      dbUp = false;
    }
  });

  it("registers and resolves the active voice provider", () => {
    expect(container.voiceProviders.get("fake-voice")).toBeDefined();
    expect(container.voiceProvider?.meta.id).toBe("fake-voice");
  });

  it("exposes the voice channel in the list registry when configured", () => {
    expect(container.listRegistry.isChannel("voice")).toBe(true);
  });

  it("404s for an unknown voice provider id", async () => {
    const res = await app.request("/v1/webhooks/voice/nonexistent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { type: "status-update" } }),
    });
    expect(res.status).toBe(404);
  });

  it("reaches the provider (401 on bad verify, not 404)", async () => {
    const res = await app.request("/v1/webhooks/voice/fake-voice", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { type: "status-update" } }),
    });
    expect(res.status).toBe(401);
  });

  it("dispatches an authorized mid-call tool call and replies with results (requires DB)", async () => {
    if (!dbUp) return; // no Postgres in this env — dispatcher needs the call row
    const res = await app.request("/v1/webhooks/voice/fake-voice", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-kind": "tool" },
      body: JSON.stringify({ message: { type: "tool-calls" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ toolCallId: string; result: string }>;
    };
    // Idempotent: the ledger may already hold t1 from a prior run — either the
    // fresh execution or the replayed result serializes to the same echo.
    expect(body.results[0]?.toolCallId).toBe("t1");
    expect(body.results[0]?.result).toContain('"v":1');
  });
});

describe("voice stub service (no provider)", () => {
  it("throws an actionable error from startCall when unconfigured", async () => {
    const container = createHogsendClient({});
    await expect(
      container.voiceService.startCall({
        // biome-ignore lint/suspicious/noExplicitAny: exercising the stub, no registry
        agentKey: "x" as any,
        props: {},
        to: "+15551230000",
      }),
    ).rejects.toThrow(/No voice provider configured/);
  });
});

describe("reserved connector id", () => {
  it("throws when a webhook source claims the reserved id 'voice'", () => {
    const badSource = defineWebhookSource({
      meta: { id: "voice", name: "bad" },
      auth: { header: "x-secret", envKey: "SOME_SECRET", type: "match" },
      async transform() {
        return null;
      },
    });
    expect(() => createHogsendClient({ webhookSources: [badSource] })).toThrow(
      /reserved/i,
    );
  });
});
