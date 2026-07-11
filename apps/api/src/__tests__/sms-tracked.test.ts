import { randomUUID } from "node:crypto";
import { defineSmsProvider, type SendSmsOptions } from "@hogsend/core";
import type { HogsendClient } from "@hogsend/engine";
import React from "react";
import { Text } from "react-email";
import { beforeAll, describe, expect, it } from "vitest";

// DB-touching test (mirrors links-vanity): the tracked SMS pipeline writes real
// sms_sends/sms_suppressions rows, so point at the real docker TimescaleDB
// BEFORE importing the engine — env is captured at module import time.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { emailPreferences, smsSends, smsSuppressions } = await import(
  "@hogsend/db"
);
const { eq } = await import("drizzle-orm");
const { createHogsendClient } = await import("@hogsend/engine");

// A fake SMS provider that records every send and can be toggled to throw, so we
// exercise the engine's tracked pipeline (DB rows, idempotency, suppression)
// without a real provider.
const sent: SendSmsOptions[] = [];
let shouldThrow = false;
const fakeProvider = defineSmsProvider({
  meta: { id: "fake-sms", name: "Fake SMS" },
  capabilities: { signedWebhooks: true, inboundMessages: true },
  async send(options) {
    sent.push(options);
    if (shouldThrow) throw new Error("provider boom");
    return { id: `SM_${sent.length}` };
  },
  verifyWebhook() {
    throw new Error("unused");
  },
  parseWebhook() {
    throw new Error("unused");
  },
});

// A trivial SMS template (rendered to plain text by the engine).
const TestSms = (props: { name?: string }) =>
  React.createElement(Text, null, `Hi ${props.name ?? "there"} from tests`);

// Marketing prose that happens to contain the bare word "stop" — must STILL
// get the compliance footer (only an opt-out INSTRUCTION suppresses it).
const StopProseSms = () =>
  React.createElement(Text, null, "Don't stop leveling up your funnel!");

// A body that already carries its own opt-out instruction — no double footer.
const StopInstructionSms = () =>
  React.createElement(Text, null, "Sale ends Friday. Reply STOP to cancel.");

let client: HogsendClient;

beforeAll(() => {
  client = createHogsendClient({
    sms: {
      provider: fakeProvider,
      from: "+15005550006",
      templates: {
        "t-sms": { component: TestSms, category: "journey" },
        "t-sms-stop-prose": { component: StopProseSms, category: "journey" },
        "t-sms-stop-instruction": {
          component: StopInstructionSms,
          category: "journey",
        },
        // biome-ignore lint/suspicious/noExplicitAny: minimal test registry
      } as any,
    },
  });
});

function uniquePhone(): string {
  // 10 digits after +1, namespaced per test to isolate rows.
  return `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
}

describe("sendTrackedSms — happy path", () => {
  it("sends and writes a `sent` row", async () => {
    const to = uniquePhone();
    const res = await client.smsService.send({
      template: "t-sms" as never,
      props: { name: "Ada" } as never,
      to,
      userId: `u_${randomUUID()}`,
    });
    expect(res.status).toBe("sent");
    expect(res.messageId).toMatch(/^SM_/);

    const rows = await client.db
      .select()
      .from(smsSends)
      .where(eq(smsSends.toPhone, to));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("sent");
    expect(rows[0]?.segments).toBeGreaterThanOrEqual(1);
    // STOP footer appended for a non-transactional body.
    expect(rows[0]?.body).toMatch(/Reply STOP to opt out/);
  });

  it("appends the footer even when prose contains the bare word 'stop'", async () => {
    const to = uniquePhone();
    await client.smsService.send({
      template: "t-sms-stop-prose" as never,
      props: {} as never,
      to,
      userId: `u_${randomUUID()}`,
    });
    const rows = await client.db
      .select()
      .from(smsSends)
      .where(eq(smsSends.toPhone, to));
    expect(rows[0]?.body).toMatch(/Reply STOP to opt out/);
  });

  it("skips the footer when the body already carries an opt-out instruction", async () => {
    const to = uniquePhone();
    await client.smsService.send({
      template: "t-sms-stop-instruction" as never,
      props: {} as never,
      to,
      userId: `u_${randomUUID()}`,
    });
    const rows = await client.db
      .select()
      .from(smsSends)
      .where(eq(smsSends.toPhone, to));
    expect(rows[0]?.body).toMatch(/Reply STOP to cancel/);
    expect(rows[0]?.body).not.toMatch(/Reply STOP to opt out/);
  });
});

describe("sendTrackedSms — idempotency", () => {
  it("short-circuits a duplicate idempotency key to the prior send", async () => {
    const to = uniquePhone();
    const key = `k_${randomUUID()}`;
    const before = sent.length;
    const a = await client.smsService.send({
      template: "t-sms" as never,
      props: {} as never,
      to,
      userId: `u_${randomUUID()}`,
      idempotencyKey: key,
    });
    const b = await client.smsService.send({
      template: "t-sms" as never,
      props: {} as never,
      to,
      userId: `u_${randomUUID()}`,
      idempotencyKey: key,
    });
    expect(a.smsSendId).toBe(b.smsSendId);
    // Exactly ONE provider call for the two logical sends.
    expect(sent.length).toBe(before + 1);
  });
});

describe("sendTrackedSms — suppression", () => {
  it("suppresses a phone on the sms_suppressions list without calling the provider", async () => {
    const to = uniquePhone();
    await client.db
      .insert(smsSuppressions)
      .values({ phone: to, reason: "inbound_stop" });
    const before = sent.length;
    const res = await client.smsService.send({
      template: "t-sms" as never,
      props: {} as never,
      to,
      userId: `u_${randomUUID()}`,
    });
    expect(res.status).toBe("suppressed");
    expect(sent.length).toBe(before); // provider NOT called
    const rows = await client.db
      .select()
      .from(smsSends)
      .where(eq(smsSends.toPhone, to));
    expect(rows[0]?.status).toBe("failed");
    // A suppressed send must NOT consume an idempotency key.
    expect(rows[0]?.idempotencyKey).toBeNull();
  });

  it("respects the sms channel opt-out on email_preferences", async () => {
    const to = uniquePhone();
    const userId = `u_${randomUUID()}`;
    await client.db.insert(emailPreferences).values({
      userId,
      email: `${userId}@example.com`,
      categories: { sms: false },
    });
    const res = await client.smsService.send({
      template: "t-sms" as never,
      props: {} as never,
      to,
      userId,
    });
    expect(res.status).toBe("unsubscribed");
  });
});

describe("sendTrackedSms — provider failure releases the key", () => {
  it("stamps failed and nulls the idempotency key so a retry re-attempts", async () => {
    const to = uniquePhone();
    const key = `k_${randomUUID()}`;
    shouldThrow = true;
    await expect(
      client.smsService.send({
        template: "t-sms" as never,
        props: {} as never,
        to,
        userId: `u_${randomUUID()}`,
        idempotencyKey: key,
      }),
    ).rejects.toThrow(/boom/);
    shouldThrow = false;

    const failed = await client.db
      .select()
      .from(smsSends)
      .where(eq(smsSends.toPhone, to));
    expect(failed[0]?.status).toBe("failed");
    expect(failed[0]?.idempotencyKey).toBeNull();

    // A retry with the SAME key is not deduped to the failed row — it re-sends.
    const res = await client.smsService.send({
      template: "t-sms" as never,
      props: {} as never,
      to,
      userId: `u_${randomUUID()}`,
      idempotencyKey: key,
    });
    expect(res.status).toBe("sent");
  });
});
