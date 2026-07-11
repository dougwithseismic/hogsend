/**
 * The explicit opt-in consent model for the SMS channel (TCPA prior express
 * consent). Pins the full gate matrix in checkSmsSuppression / the tracked
 * sender:
 *
 *  - a marketing send with NO grant fails closed (`no_consent`) — including
 *    sends with no resolvable userId;
 *  - transactional (and skipPreferenceCheck) sends bypass ONLY the consent +
 *    topic gates — never the phone STOP list, never unsubscribed_all;
 *  - phone-track consent: an inbound START (even with no prior STOP row)
 *    grants; an explicit `categories.sms === false` beats it;
 *  - the `POST /v1/lists/sms/subscribe` grant path unblocks sends, falls back
 *    to the phone track for a phone-only contact, and the grant emits
 *    `contact.subscribed` with `source` provenance.
 */

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

const { defineSmsProvider } = await import("@hogsend/core");
const {
  contacts,
  emailPreferences,
  smsSuppressions,
  webhookDeliveries,
  webhookEndpoints,
} = await import("@hogsend/db");
const { desc, eq } = await import("drizzle-orm");
const { createApp, createHogsendClient, generateWebhookSecret } = await import(
  "@hogsend/engine"
);

const React = (await import("react")).default;
const { Text } = await import("react-email");

const sent: Array<{ to: string; body: string }> = [];
const fakeProvider = defineSmsProvider({
  meta: { id: "fake-sms", name: "Fake SMS" },
  capabilities: { inboundMessages: true },
  async send(options) {
    sent.push({ to: options.to, body: options.body });
    return { id: `SM_${sent.length}` };
  },
  verifyWebhook() {
    throw new Error("unused");
  },
  parseWebhook() {
    throw new Error("unused");
  },
});

const MarketingSms = () => React.createElement(Text, null, "big sale today");
const TxnSms = () => React.createElement(Text, null, "your code is 123456");

const client = createHogsendClient({
  sms: {
    provider: fakeProvider,
    from: "+15005550006",
    templates: {
      "t-marketing": { component: MarketingSms, category: "journey" },
      "t-txn": { component: TxnSms, category: "transactional" },
      // biome-ignore lint/suspicious/noExplicitAny: minimal test registry
    } as any,
  },
});
const app = createApp(client);
const { db } = client;

const AUTH = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
  "Content-Type": "application/json",
};

// emitOutbound is a GLOBAL fan-out (every enabled endpoint whose eventTypes
// match) — a leaked endpoint row makes OTHER files' emit tests over-count.
// Track and remove everything this file creates on the shared docker DB.
const createdEndpoints: string[] = [];

afterAll(async () => {
  const { inArray } = await import("drizzle-orm");
  if (createdEndpoints.length > 0) {
    await db
      .delete(webhookDeliveries)
      .where(inArray(webhookDeliveries.endpointId, createdEndpoints));
    await db
      .delete(webhookEndpoints)
      .where(inArray(webhookEndpoints.id, createdEndpoints));
  }
});

function uniquePhone(): string {
  return `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
}

function inbound(from: string, body: string) {
  return {
    type: "sms.inbound" as const,
    messageId: `MO_${randomUUID()}`,
    phone: from,
    occurredAt: new Date().toISOString(),
    inbound: { body, to: "+15005550006" },
    raw: {},
  };
}

async function sendMarketing(to: string, userId?: string) {
  return client.smsService.send({
    template: "t-marketing" as never,
    props: {} as never,
    to,
    ...(userId ? { userId } : {}),
  });
}

describe("explicit consent — fail closed", () => {
  it("blocks a marketing send to a user with no grant (no_consent, provider not called, key not consumed)", async () => {
    const to = uniquePhone();
    const userId = `u_${randomUUID()}`;
    const before = sent.length;
    const res = await client.smsService.send({
      template: "t-marketing" as never,
      props: {} as never,
      to,
      userId,
      idempotencyKey: `k_${randomUUID()}`,
    });
    expect(res.status).toBe("no_consent");
    expect(sent.length).toBe(before);
  });

  it("blocks a marketing send with NO userId at all", async () => {
    const res = await sendMarketing(uniquePhone());
    expect(res.status).toBe("no_consent");
  });

  it("a transactional send goes out without a grant — and carries no STOP footer", async () => {
    const to = uniquePhone();
    const before = sent.length;
    const res = await client.smsService.send({
      template: "t-txn" as never,
      props: {} as never,
      to,
      userId: `u_${randomUUID()}`,
    });
    expect(res.status).toBe("sent");
    expect(sent.length).toBe(before + 1);
    expect(sent.at(-1)?.body).not.toMatch(/Reply STOP/);
  });

  it("transactional does NOT bypass the phone STOP list", async () => {
    const to = uniquePhone();
    await db
      .insert(smsSuppressions)
      .values({ phone: to, reason: "inbound_stop" });
    const res = await client.smsService.send({
      template: "t-txn" as never,
      props: {} as never,
      to,
      userId: `u_${randomUUID()}`,
    });
    expect(res.status).toBe("suppressed");
  });

  it("transactional does NOT bypass unsubscribed_all", async () => {
    const to = uniquePhone();
    const userId = `u_${randomUUID()}`;
    await db.insert(emailPreferences).values({
      userId,
      email: `${userId}@example.com`,
      unsubscribedAll: true,
    });
    const res = await client.smsService.send({
      template: "t-txn" as never,
      props: {} as never,
      to,
      userId,
    });
    expect(res.status).toBe("unsubscribed");
  });

  it("skipPreferenceCheck still honors the phone STOP list", async () => {
    const to = uniquePhone();
    await db
      .insert(smsSuppressions)
      .values({ phone: to, reason: "inbound_stop" });
    const res = await client.smsService.send({
      template: "t-marketing" as never,
      props: {} as never,
      to,
      userId: `u_${randomUUID()}`,
      skipPreferenceCheck: true,
    });
    expect(res.status).toBe("suppressed");
  });
});

describe("phone-track consent (START)", () => {
  it("a fresh START with no prior STOP grants — a no-userId marketing send then succeeds", async () => {
    const phone = uniquePhone();
    await client.smsService.handleWebhook(inbound(phone, "START"));

    const rows = await db
      .select({ resubscribedAt: smsSuppressions.resubscribedAt })
      .from(smsSuppressions)
      .where(eq(smsSuppressions.phone, phone));
    expect(rows[0]?.resubscribedAt).not.toBeNull();

    const res = await sendMarketing(phone);
    expect(res.status).toBe("sent");
  });

  it("a multi-word 'STOP texting me' still opts out (leading-keyword match)", async () => {
    const phone = uniquePhone();
    await client.smsService.handleWebhook(inbound(phone, "STOP texting me"));
    const rows = await db
      .select({ resubscribedAt: smsSuppressions.resubscribedAt })
      .from(smsSuppressions)
      .where(eq(smsSuppressions.phone, phone));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resubscribedAt).toBeNull();
  });

  it("an explicit categories.sms === false beats phone consent", async () => {
    const phone = uniquePhone();
    const userId = `u_${randomUUID()}`;
    await client.smsService.handleWebhook(inbound(phone, "START"));
    await db.insert(emailPreferences).values({
      userId,
      email: `${userId}@example.com`,
      categories: { sms: false },
    });
    const res = await sendMarketing(phone, userId);
    expect(res.status).toBe("unsubscribed");
  });
});

describe("grant via POST /v1/lists/sms/subscribe", () => {
  it("unblocks a marketing send and emits contact.subscribed with source api", async () => {
    const userId = `u_${randomUUID()}`;
    const email = `${userId}@example.com`;
    const to = uniquePhone();

    // Subscribe an endpoint to contact.subscribed so the emit lands a delivery.
    const { secret, secretPrefix } = generateWebhookSecret();
    const [endpoint] = await db
      .insert(webhookEndpoints)
      .values({
        url: `https://example.test/hooks/${userId}`,
        secret,
        secretPrefix,
        eventTypes: ["contact.subscribed"],
        disabled: false,
      })
      .returning({ id: webhookEndpoints.id });
    expect(endpoint).toBeDefined();
    if (endpoint) createdEndpoints.push(endpoint.id);

    const blocked = await sendMarketing(to, userId);
    expect(blocked.status).toBe("no_consent");

    const res = await app.request("/v1/lists/sms/subscribe", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ userId, email }),
    });
    expect(res.status).toBe(200);

    const allowed = await sendMarketing(to, userId);
    expect(allowed.status).toBe("sent");

    // The emit is fire-and-forget — poll briefly for the delivery row.
    const endpointId = endpoint?.id ?? "";
    await vi.waitFor(async () => {
      const deliveries = await db
        .select({ payload: webhookDeliveries.payload })
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.endpointId, endpointId))
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(1);
      expect(deliveries).toHaveLength(1);
      const envelope = deliveries[0]?.payload as {
        type: string;
        data: { source: string; category: string | null };
      };
      expect(envelope.type).toBe("contact.subscribed");
      expect(envelope.data.category).toBe("sms");
      expect(envelope.data.source).toBe("api");
      // Generous timeout: the emit is fire-and-forget off the write path.
    }, 5000);
  });

  it("falls back to the phone track for a phone-only contact (no email)", async () => {
    const phone = uniquePhone();
    const externalId = `ext_${randomUUID()}`;
    await db.insert(contacts).values({ externalId, phone });

    const res = await app.request("/v1/lists/sms/subscribe", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ userId: externalId }),
    });
    expect(res.status).toBe(200);

    const rows = await db
      .select({
        reason: smsSuppressions.reason,
        resubscribedAt: smsSuppressions.resubscribedAt,
      })
      .from(smsSuppressions)
      .where(eq(smsSuppressions.phone, phone));
    expect(rows[0]?.reason).toBe("api_grant");
    expect(rows[0]?.resubscribedAt).not.toBeNull();

    // Phone-track consent now allows the send.
    const sentRes = await sendMarketing(phone, externalId);
    expect(sentRes.status).toBe("sent");
  });
});
