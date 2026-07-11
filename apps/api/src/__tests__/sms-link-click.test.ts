/**
 * DB-backed proof of the SMS short-link pipeline end to end: the tracked
 * sender rewrites the rendered body to `/s/<code>` and commits the
 * tracked_links rows atomically with the sms_sends row; `GET /s/:code`
 * 302-redirects, records the click, sets first-touch `sms_sends.clicked_at`,
 * emits `sms.clicked` outbound, and re-ingests `sms.link_clicked` for
 * journeys (bot-gated, identity-gated); the idempotent re-drive wires the
 * STORED body and never duplicates tracked rows.
 */

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

// Mock hatchet so ingestEvent's push is inert (mirrors links-vanity).
vi.mock("../../../../packages/engine/src/lib/hatchet.js", () => ({
  hatchet: {
    durableTask: vi.fn(() => ({
      run: vi.fn(),
      runNoWait: vi.fn(),
      runAndWait: vi.fn(),
    })),
    task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
    events: { push: vi.fn(async () => {}) },
    runs: { cancel: vi.fn(async () => {}), get: vi.fn() },
    worker: vi.fn(),
  },
}));

const { defineSmsProvider } = await import("@hogsend/core");
const {
  emailPreferences,
  linkClicks,
  smsSends,
  trackedLinks,
  userEvents,
  webhookDeliveries,
  webhookEndpoints,
} = await import("@hogsend/db");
const { desc, eq, inArray } = await import("drizzle-orm");
const { createApp, createHogsendClient, generateWebhookSecret } = await import(
  "@hogsend/engine"
);

const React = (await import("react")).default;
const { Text } = await import("react-email");

const sent: Array<{ to: string; body: string }> = [];
const fakeProvider = defineSmsProvider({
  meta: { id: "fake-sms", name: "Fake SMS" },
  capabilities: {},
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

const DEST = "https://example.com/growth-report";
const LinkSms = () =>
  React.createElement(Text, null, `Your report is ready: ${DEST} — enjoy!`);

const client = createHogsendClient({
  sms: {
    provider: fakeProvider,
    from: "+15005550006",
    // biome-ignore lint/suspicious/noExplicitAny: minimal test registry
    templates: { "t-link": { component: LinkSms, category: "journey" } } as any,
  },
});
const app = createApp(client);
const { db, env } = client;

const createdUsers: string[] = [];
const createdEndpoints: string[] = [];

afterAll(async () => {
  if (createdEndpoints.length > 0) {
    await db
      .delete(webhookDeliveries)
      .where(inArray(webhookDeliveries.endpointId, createdEndpoints));
    await db
      .delete(webhookEndpoints)
      .where(inArray(webhookEndpoints.id, createdEndpoints));
  }
  if (createdUsers.length > 0) {
    await db.delete(userEvents).where(inArray(userEvents.userId, createdUsers));
    await db
      .delete(emailPreferences)
      .where(inArray(emailPreferences.userId, createdUsers));
    // tracked_links + link_clicks cascade off sms_sends.
    await db.delete(smsSends).where(inArray(smsSends.userId, createdUsers));
  }
});

function uniquePhone(): string {
  return `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
}

// The sms channel is explicit opt-in — every sending test grants first.
async function grantedUser(): Promise<string> {
  const userId = `u_${randomUUID()}`;
  createdUsers.push(userId);
  await db.insert(emailPreferences).values({
    userId,
    email: `${userId}@example.com`,
    categories: { sms: true },
  });
  return userId;
}

async function sendLinkSms(opts?: {
  userId?: string;
  idempotencyKey?: string;
}) {
  const to = uniquePhone();
  const userId = opts?.userId ?? (await grantedUser());
  const res = await client.smsService.send({
    template: "t-link" as never,
    props: {} as never,
    to,
    userId,
    idempotencyKey: opts?.idempotencyKey,
  });
  expect(res.status).toBe("sent");
  const [row] = await db
    .select()
    .from(smsSends)
    .where(eq(smsSends.id, res.smsSendId));
  if (!row) throw new Error("send row missing");
  return { res, row, userId, to };
}

function codeFrom(body: string): string {
  const m = body.match(/\/s\/([a-z0-9]{8})/);
  if (!m?.[1]) throw new Error(`no short code in body: ${body}`);
  return m[1];
}

describe("mint — the tracked sender rewrites and commits atomically", () => {
  it("wire body carries /s/<code>, stored body === wire body, footer intact after the link", async () => {
    const { row } = await sendLinkSms();
    const wire = sent.at(-1);
    expect(wire?.body).toContain(`${env.API_PUBLIC_URL}/s/`);
    expect(wire?.body).not.toContain(DEST);
    expect(row.body).toBe(wire?.body);
    // Footer appended AFTER the rewrite and left un-rewritten.
    expect(row.body).toMatch(/Reply STOP to opt out$/);

    const code = codeFrom(row.body);
    const [tracked] = await db
      .select()
      .from(trackedLinks)
      .where(eq(trackedLinks.shortCode, code));
    expect(tracked).toMatchObject({
      smsSendId: row.id,
      source: "sms",
      originalUrl: DEST,
      emailSendId: null,
      linkId: null,
    });
  });
});

describe("click — GET /s/:code", () => {
  it("302s to the original URL, records the click, sets first-touch clickedAt", async () => {
    const { row } = await sendLinkSms();
    const code = codeFrom(row.body);

    const res = await app.request(`/s/${code}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(DEST);

    const [tracked] = await db
      .select()
      .from(trackedLinks)
      .where(eq(trackedLinks.shortCode, code));
    expect(tracked?.clickCount).toBe(1);
    const clicks = await db
      .select()
      .from(linkClicks)
      .where(eq(linkClicks.trackedLinkId, tracked?.id ?? ""));
    expect(clicks).toHaveLength(1);

    const [send] = await db
      .select({ clickedAt: smsSends.clickedAt })
      .from(smsSends)
      .where(eq(smsSends.id, row.id));
    expect(send?.clickedAt).not.toBeNull();

    // Second click: counted per-hit, clickedAt unchanged (first-touch).
    const firstClickedAt = send?.clickedAt;
    await app.request(`/s/${code}`);
    const [tracked2] = await db
      .select({ clickCount: trackedLinks.clickCount })
      .from(trackedLinks)
      .where(eq(trackedLinks.shortCode, code));
    expect(tracked2?.clickCount).toBe(2);
    const [send2] = await db
      .select({ clickedAt: smsSends.clickedAt })
      .from(smsSends)
      .where(eq(smsSends.id, row.id));
    expect(send2?.clickedAt?.getTime()).toBe(firstClickedAt?.getTime());
  });

  it("unknown and malformed codes redirect home", async () => {
    for (const path of ["/s/zzzzzzzz", "/s/!bad!"]) {
      const res = await app.request(path);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(env.API_PUBLIC_URL);
    }
  });

  it("emits sms.clicked outbound and re-ingests sms.link_clicked for the contact", async () => {
    const { secret, secretPrefix } = generateWebhookSecret();
    const [endpoint] = await db
      .insert(webhookEndpoints)
      .values({
        url: `https://example.test/sms-clicks/${randomUUID()}`,
        secret,
        secretPrefix,
        eventTypes: ["sms.clicked"],
        disabled: false,
      })
      .returning({ id: webhookEndpoints.id });
    if (endpoint) createdEndpoints.push(endpoint.id);

    const { row, userId } = await sendLinkSms();
    const code = codeFrom(row.body);
    await app.request(`/s/${code}`);

    await vi.waitFor(async () => {
      const deliveries = await db
        .select({ payload: webhookDeliveries.payload })
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.endpointId, endpoint?.id ?? ""))
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(1);
      expect(deliveries).toHaveLength(1);
      const envelope = deliveries[0]?.payload as {
        type: string;
        data: { smsSendId: string; linkUrl: string; userId: string | null };
      };
      expect(envelope.type).toBe("sms.clicked");
      expect(envelope.data.smsSendId).toBe(row.id);
      expect(envelope.data.linkUrl).toBe(DEST);
      expect(envelope.data.userId).toBe(userId);
      // Generous timeout: the emit is fire-and-forget off the redirect path.
    }, 5000);

    await vi.waitFor(async () => {
      const events = await db
        .select({ event: userEvents.event })
        .from(userEvents)
        .where(eq(userEvents.userId, userId));
      expect(events.map((e) => e.event)).toContain("sms.link_clicked");
    }, 5000);
  });

  it("suppresses the bus re-ingest for an unfurl bot (click still counted)", async () => {
    const { row, userId } = await sendLinkSms();
    const code = codeFrom(row.body);

    const res = await app.request(`/s/${code}`, {
      headers: { "user-agent": "Slackbot-LinkExpanding 1.0" },
    });
    expect(res.status).toBe(302);

    const [tracked] = await db
      .select({ clickCount: trackedLinks.clickCount })
      .from(trackedLinks)
      .where(eq(trackedLinks.shortCode, code));
    expect(tracked?.clickCount).toBe(1);

    // Give the async chain a beat, then assert NO bus event landed.
    await new Promise((r) => setTimeout(r, 300));
    const events = await db
      .select({ event: userEvents.event })
      .from(userEvents)
      .where(eq(userEvents.userId, userId));
    expect(events.map((e) => e.event)).not.toContain("sms.link_clicked");
  });
});

describe("idempotent re-drive — stored body, no duplicate tracked rows", () => {
  it("a second keyed send short-circuits without re-minting", async () => {
    const key = `k_${randomUUID()}`;
    const userId = await grantedUser();
    const first = await sendLinkSms({ userId, idempotencyKey: key });

    const again = await client.smsService.send({
      template: "t-link" as never,
      props: {} as never,
      to: first.to,
      userId,
      idempotencyKey: key,
    });
    expect(again.smsSendId).toBe(first.row.id);

    const rows = await db
      .select({ id: trackedLinks.id })
      .from(trackedLinks)
      .where(eq(trackedLinks.smsSendId, first.row.id));
    expect(rows).toHaveLength(1);
  });

  it("a crash replay of a queued row wires the STORED body verbatim", async () => {
    // Simulate the crash window: a queued row + its tracked link exist, the
    // provider was never called. A re-drive with the same key must wire the
    // stored body (same code), not re-render/re-mint.
    const userId = await grantedUser();
    const to = uniquePhone();
    const key = `k_${randomUUID()}`;
    const rowId = randomUUID();
    const code = "qqrsttvw";
    const storedBody = `Your report is ready: ${env.API_PUBLIC_URL}/s/${code} — enjoy!\n\nReply STOP to opt out`;
    await db.insert(smsSends).values({
      id: rowId,
      templateKey: "t-link",
      fromPhone: "+15005550006",
      toPhone: to,
      body: storedBody,
      category: "journey",
      userId,
      status: "queued",
      idempotencyKey: key,
    });
    await db.insert(trackedLinks).values({
      smsSendId: rowId,
      source: "sms",
      originalUrl: DEST,
      shortCode: code,
    });

    const res = await client.smsService.send({
      template: "t-link" as never,
      props: {} as never,
      to,
      userId,
      idempotencyKey: key,
    });
    expect(res.status).toBe("sent");
    expect(res.smsSendId).toBe(rowId);
    expect(sent.at(-1)?.body).toBe(storedBody);

    const rows = await db
      .select({ id: trackedLinks.id })
      .from(trackedLinks)
      .where(eq(trackedLinks.smsSendId, rowId));
    expect(rows).toHaveLength(1);
  });
});

describe("config", () => {
  it("linkTracking: false sends the raw URL and mints nothing", async () => {
    const { createTrackedSmsSender } = await import("@hogsend/engine");
    const sender = createTrackedSmsSender(
      {
        defaultFrom: "+15005550006",
        db,
        linkTracking: false,
        linkHost: env.API_PUBLIC_URL,
        templates: {
          "t-link": { component: LinkSms, category: "journey" },
          // biome-ignore lint/suspicious/noExplicitAny: minimal test registry
        } as any,
      },
      { provider: fakeProvider },
    );
    const userId = await grantedUser();
    const to = uniquePhone();
    const res = await sender.send({
      template: "t-link" as never,
      props: {} as never,
      to,
      userId,
    });
    expect(res.status).toBe("sent");
    expect(sent.at(-1)?.body).toContain(DEST);
    const rows = await db
      .select({ id: trackedLinks.id })
      .from(trackedLinks)
      .where(eq(trackedLinks.smsSendId, res.smsSendId));
    expect(rows).toHaveLength(0);
  });

  it("linkHost override swaps the short base", async () => {
    const { createTrackedSmsSender } = await import("@hogsend/engine");
    const sender = createTrackedSmsSender(
      {
        defaultFrom: "+15005550006",
        db,
        linkHost: "https://hs.example",
        templates: {
          "t-link": { component: LinkSms, category: "journey" },
          // biome-ignore lint/suspicious/noExplicitAny: minimal test registry
        } as any,
      },
      { provider: fakeProvider },
    );
    const userId = await grantedUser();
    const res = await sender.send({
      template: "t-link" as never,
      props: {} as never,
      to: uniquePhone(),
      userId,
    });
    expect(res.status).toBe("sent");
    expect(sent.at(-1)?.body).toContain("https://hs.example/s/");
  });
});
