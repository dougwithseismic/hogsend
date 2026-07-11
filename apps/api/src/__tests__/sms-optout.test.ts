import { randomUUID } from "node:crypto";
import { defineSmsProvider, type SmsEvent } from "@hogsend/core";
import type { HogsendClient } from "@hogsend/engine";
import React from "react";
import { Text } from "react-email";
import { beforeAll, describe, expect, it } from "vitest";

// DB-touching test (mirrors links-vanity): inbound STOP/START writes real
// sms_suppressions/contacts/email_preferences rows, so point at the real docker
// TimescaleDB BEFORE importing the engine — env is captured at module import.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, emailPreferences, smsSuppressions } = await import(
  "@hogsend/db"
);
const { and, eq, isNull } = await import("drizzle-orm");
const { createHogsendClient } = await import("@hogsend/engine");

const replies: Array<{ to: string; body: string }> = [];
const fakeProvider = defineSmsProvider({
  meta: { id: "fake-sms", name: "Fake SMS" },
  capabilities: { signedWebhooks: true, inboundMessages: true },
  async send(options) {
    replies.push({ to: options.to, body: options.body });
    return { id: "SM_reply" };
  },
  verifyWebhook(): SmsEvent {
    throw new Error("unused");
  },
  parseWebhook(): SmsEvent {
    throw new Error("unused");
  },
});

const TestSms = () => React.createElement(Text, null, "hi");

let client: HogsendClient;
beforeAll(() => {
  client = createHogsendClient({
    sms: {
      provider: fakeProvider,
      from: "+15005550006",
      // biome-ignore lint/suspicious/noExplicitAny: minimal test registry
      templates: { "t-sms": { component: TestSms } } as any,
    },
  });
});

function inbound(from: string, body: string, to = "+15005550006"): SmsEvent {
  return {
    type: "sms.inbound",
    messageId: `MO_${randomUUID()}`,
    phone: from,
    occurredAt: new Date(0).toISOString(),
    inbound: { body, to },
    raw: {},
  };
}

function uniquePhone(): string {
  return `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
}

async function isSuppressed(phone: string): Promise<boolean> {
  const rows = await client.db
    .select({ id: smsSuppressions.id })
    .from(smsSuppressions)
    .where(
      and(
        eq(smsSuppressions.phone, phone),
        isNull(smsSuppressions.resubscribedAt),
      ),
    );
  return rows.length > 0;
}

describe("inbound STOP handling", () => {
  it("suppresses an unresolvable number (no contact) on STOP", async () => {
    const phone = uniquePhone();
    await client.smsService.handleWebhook(inbound(phone, "STOP"));
    expect(await isSuppressed(phone)).toBe(true);
  });

  it("normalizes keyword casing/punctuation", async () => {
    const phone = uniquePhone();
    await client.smsService.handleWebhook(inbound(phone, " Stop. "));
    expect(await isSuppressed(phone)).toBe(true);

    const phone2 = uniquePhone();
    await client.smsService.handleWebhook(inbound(phone2, "unsubscribe"));
    expect(await isSuppressed(phone2)).toBe(true);
  });

  it("flips the sms channel category when the phone resolves to a contact", async () => {
    const phone = uniquePhone();
    const externalId = `ext_${randomUUID()}`;
    const email = `${externalId}@example.com`;
    await client.db.insert(contacts).values({ externalId, email, phone });

    await client.smsService.handleWebhook(inbound(phone, "STOP"));

    const prefs = await client.db
      .select()
      .from(emailPreferences)
      .where(eq(emailPreferences.userId, externalId));
    expect(prefs[0]?.categories).toMatchObject({ sms: false });
  });

  it("resubscribes on START", async () => {
    const phone = uniquePhone();
    await client.smsService.handleWebhook(inbound(phone, "STOP"));
    expect(await isSuppressed(phone)).toBe(true);
    await client.smsService.handleWebhook(inbound(phone, "START"));
    expect(await isSuppressed(phone)).toBe(false);
  });

  it("does not send a confirmation reply by default (optOutReplies off)", async () => {
    const before = replies.length;
    await client.smsService.handleWebhook(inbound(uniquePhone(), "STOP"));
    expect(replies.length).toBe(before);
  });
});
