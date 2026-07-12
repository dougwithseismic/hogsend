import { randomUUID } from "node:crypto";
import {
  defineVoiceProvider,
  type StartCallOptions,
  type VoiceWebhookParsed,
} from "@hogsend/core";
import type { HogsendClient } from "@hogsend/engine";
import { defineVoiceAgent } from "@hogsend/voice";
import { beforeAll, describe, expect, it } from "vitest";

// DB-touching test (mirrors sms-tracked): the tracked voice pipeline writes real
// voice_calls / voice_suppressions rows, so point at the real docker TimescaleDB
// BEFORE importing the engine — env is captured at module import time.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { emailPreferences, voiceCalls, voiceSuppressions } = await import(
  "@hogsend/db"
);
const { eq } = await import("drizzle-orm");
const { createHogsendClient } = await import("@hogsend/engine");

// A fake voice provider that records every startCall and can be toggled to throw,
// so we exercise the engine's tracked pipeline (DB rows, idempotency, DNC)
// without a real provider.
const placed: StartCallOptions[] = [];
let shouldThrow = false;
const fakeProvider = defineVoiceProvider({
  meta: { id: "fake-voice", name: "Fake Voice" },
  capabilities: { outboundCalls: true, midCallTools: true },
  async startCall(options) {
    placed.push(options);
    if (shouldThrow) throw new Error("provider boom");
    return { id: `call_${placed.length}` };
  },
  verifyWebhook(): VoiceWebhookParsed {
    throw new Error("unused");
  },
  parseWebhook(): VoiceWebhookParsed {
    throw new Error("unused");
  },
  encodeToolResults(results) {
    return { results };
  },
});

const testAgent = defineVoiceAgent({
  category: "journey",
  build: () => ({
    systemPrompt: "You are a test agent.",
    tools: [{ name: "echo", parameters: { type: "object", properties: {} } }],
  }),
});

let client: HogsendClient;

beforeAll(() => {
  client = createHogsendClient({
    voice: {
      provider: fakeProvider,
      from: "+15005550006",
      // biome-ignore lint/suspicious/noExplicitAny: minimal test registry
      agents: { "t-voice": testAgent } as any,
    },
  });
});

function uniquePhone(): string {
  return `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
}

// The voice channel is EXPLICIT OPT-IN: a call needs a `categories.voice === true`
// grant. Every test that expects to reach the provider grants first.
async function grantedUser(): Promise<string> {
  const userId = `u_${randomUUID()}`;
  await client.db.insert(emailPreferences).values({
    userId,
    email: `${userId}@example.com`,
    categories: { voice: true },
  });
  return userId;
}

describe("sendTrackedVoiceCall — happy path", () => {
  it("places a call and writes a `ringing` row with allowedTools", async () => {
    const to = uniquePhone();
    const res = await client.voiceService.startCall({
      agentKey: "t-voice" as never,
      props: {} as never,
      to,
      userId: await grantedUser(),
    });
    expect(res.status).toBe("started");
    expect(res.providerCallId).toMatch(/^call_/);

    const rows = await client.db
      .select()
      .from(voiceCalls)
      .where(eq(voiceCalls.toNumber, to));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("ringing");
    expect(rows[0]?.providerId).toBe("fake-voice");
    expect(rows[0]?.metadata).toMatchObject({ allowedTools: ["echo"] });
  });
});

describe("sendTrackedVoiceCall — consent (explicit opt-in)", () => {
  it("fails closed with no_consent when there is no grant", async () => {
    const to = uniquePhone();
    const before = placed.length;
    const res = await client.voiceService.startCall({
      agentKey: "t-voice" as never,
      props: {} as never,
      to,
      userId: `u_${randomUUID()}`,
    });
    expect(res.status).toBe("no_consent");
    expect(placed.length).toBe(before); // provider NOT called
  });

  it("respects the voice channel opt-out on email_preferences", async () => {
    const to = uniquePhone();
    const userId = `u_${randomUUID()}`;
    await client.db.insert(emailPreferences).values({
      userId,
      email: `${userId}@example.com`,
      categories: { voice: false },
    });
    const res = await client.voiceService.startCall({
      agentKey: "t-voice" as never,
      props: {} as never,
      to,
      userId,
    });
    expect(res.status).toBe("unsubscribed");
  });
});

describe("sendTrackedVoiceCall — DNC suppression", () => {
  it("suppresses a phone on the voice_suppressions DNC without calling the provider", async () => {
    const to = uniquePhone();
    await client.db
      .insert(voiceSuppressions)
      .values({ phone: to, reason: "opt_out" });
    const before = placed.length;
    const res = await client.voiceService.startCall({
      agentKey: "t-voice" as never,
      props: {} as never,
      to,
      userId: await grantedUser(),
    });
    expect(res.status).toBe("suppressed");
    expect(placed.length).toBe(before);
    const rows = await client.db
      .select()
      .from(voiceCalls)
      .where(eq(voiceCalls.toNumber, to));
    expect(rows[0]?.status).toBe("failed");
    // A suppressed call must NOT consume an idempotency key.
    expect(rows[0]?.idempotencyKey).toBeNull();
  });
});

describe("sendTrackedVoiceCall — idempotency", () => {
  it("short-circuits a duplicate idempotency key to the prior call (no double-dial)", async () => {
    const to = uniquePhone();
    const key = `k_${randomUUID()}`;
    const userId = await grantedUser();
    const before = placed.length;
    const a = await client.voiceService.startCall({
      agentKey: "t-voice" as never,
      props: {} as never,
      to,
      userId,
      idempotencyKey: key,
    });
    const b = await client.voiceService.startCall({
      agentKey: "t-voice" as never,
      props: {} as never,
      to,
      userId,
      idempotencyKey: key,
    });
    expect(a.voiceCallId).toBe(b.voiceCallId);
    // Exactly ONE provider call for the two logical calls.
    expect(placed.length).toBe(before + 1);
  });
});

describe("sendTrackedVoiceCall — provider failure releases the key", () => {
  it("stamps failed and nulls the idempotency key so a retry re-attempts", async () => {
    const to = uniquePhone();
    const key = `k_${randomUUID()}`;
    shouldThrow = true;
    await expect(
      client.voiceService.startCall({
        agentKey: "t-voice" as never,
        props: {} as never,
        to,
        userId: await grantedUser(),
        idempotencyKey: key,
      }),
    ).rejects.toThrow(/boom/);
    shouldThrow = false;

    const failed = await client.db
      .select()
      .from(voiceCalls)
      .where(eq(voiceCalls.toNumber, to));
    expect(failed[0]?.status).toBe("failed");
    expect(failed[0]?.idempotencyKey).toBeNull();

    const res = await client.voiceService.startCall({
      agentKey: "t-voice" as never,
      props: {} as never,
      to,
      userId: await grantedUser(),
      idempotencyKey: key,
    });
    expect(res.status).toBe("started");
  });
});

describe("sendTrackedVoiceCall — test mode", () => {
  async function makeTestModeCaller(testPhone?: string) {
    const { createTrackedVoiceCaller } = await import("@hogsend/engine");
    return createTrackedVoiceCaller(
      {
        defaultFrom: "+15005550006",
        db: client.db,
        testMode: () => true,
        testPhone,
        // biome-ignore lint/suspicious/noExplicitAny: minimal test registry
        agents: { "t-voice": testAgent } as any,
      },
      { provider: fakeProvider },
    );
  }

  it("redirects the call to HOGSEND_TEST_PHONE and records the original recipient", async () => {
    const caller = await makeTestModeCaller("+15005550099");
    const to = uniquePhone();
    const before = placed.length;
    const res = await caller.startCall({
      agentKey: "t-voice" as never,
      props: {} as never,
      to,
      userId: await grantedUser(),
    });
    expect(res.status).toBe("started");
    expect(placed[before]?.to).toBe("+15005550099");
    const rows = await client.db
      .select()
      .from(voiceCalls)
      .where(eq(voiceCalls.toNumber, "+15005550099"));
    expect(rows.at(-1)?.metadata).toMatchObject({
      testMode: true,
      originalTo: to,
    });
  });

  it("blocks the call when test mode is active but no test phone is set", async () => {
    const caller = await makeTestModeCaller(undefined);
    const to = uniquePhone();
    const before = placed.length;
    const res = await caller.startCall({
      agentKey: "t-voice" as never,
      props: {} as never,
      to,
      userId: await grantedUser(),
    });
    expect(res.status).toBe("skipped");
    expect(res.reason).toBe("test_mode_blocked");
    expect(placed.length).toBe(before);
  });
});

describe("voice webhook — monotonic lifecycle + outcome", () => {
  it("advances to completed on call_ended and a late call_started can't regress it", async () => {
    const to = uniquePhone();
    await client.voiceService.startCall({
      agentKey: "t-voice" as never,
      props: {} as never,
      to,
      userId: await grantedUser(),
    });
    const [row] = await client.db
      .select({ providerCallId: voiceCalls.providerCallId })
      .from(voiceCalls)
      .where(eq(voiceCalls.toNumber, to));
    const callId = row?.providerCallId ?? "";

    await client.voiceService.handleWebhook(
      {
        type: "voice.call_ended",
        callId,
        phone: to,
        occurredAt: new Date().toISOString(),
        ended: { reason: "customer-ended-call", durationSec: 30 },
        raw: {},
      },
      "fake-voice",
    );
    // A delayed call_started echo must NOT regress a completed row.
    await client.voiceService.handleWebhook(
      {
        type: "voice.call_started",
        callId,
        phone: to,
        occurredAt: new Date().toISOString(),
        raw: {},
      },
      "fake-voice",
    );

    const [after] = await client.db
      .select({
        status: voiceCalls.status,
        endedReason: voiceCalls.endedReason,
      })
      .from(voiceCalls)
      .where(eq(voiceCalls.toNumber, to));
    expect(after?.status).toBe("completed");
    expect(after?.endedReason).toBe("customer-ended-call");
  });
});
