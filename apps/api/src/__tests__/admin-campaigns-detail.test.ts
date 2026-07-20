import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

vi.mock("../lib/hatchet.js", () => ({
  hatchet: {
    durableTask: vi.fn(() => ({
      run: vi.fn(),
      runNoWait: vi.fn(),
      runAndWait: vi.fn(),
    })),
    task: vi.fn(() => ({
      run: vi.fn(),
      runNoWait: vi.fn(),
    })),
    events: { push: vi.fn() },
    runs: { cancel: vi.fn(), get: vi.fn() },
    worker: vi.fn(),
  },
}));

vi.mock("../workflows/send-email.js", () => ({
  sendEmailTask: { run: vi.fn(), runNoWait: vi.fn() },
}));

const { campaigns, emailSends } = await import("@hogsend/db");
const { eq, inArray } = await import("drizzle-orm");
const { createApp, createHogsendClient } = await import("@hogsend/engine");

const container = createHogsendClient();
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
};

let campaignId: string;
let otherCampaignId: string;
let createdSendIds: string[] = [];

const base = new Date("2026-01-01T00:00:00.000Z");

beforeAll(async () => {
  const rows = await db
    .insert(campaigns)
    .values([
      {
        name: "Stats test campaign",
        status: "sent",
        audienceKind: "list",
        audienceId: "stats-test-list",
        templateKey: "stats-test-template",
        totalRecipients: 3,
        sentCount: 2,
        skippedCount: 0,
        failedCount: 1,
        startedAt: base,
        completedAt: new Date(base.getTime() + 60000),
      },
      {
        name: "Other campaign",
        status: "sent",
        audienceKind: "list",
        audienceId: "stats-test-list",
        templateKey: "stats-test-template",
      },
    ])
    .returning({ id: campaigns.id });
  campaignId = rows[0]?.id ?? "";
  otherCampaignId = rows[1]?.id ?? "";

  const sendRows = await db
    .insert(emailSends)
    .values([
      // Full engagement: delivered + opened + clicked.
      {
        templateKey: "stats-test-template",
        fromEmail: "from@hogsend.com",
        toEmail: "clicked@example.com",
        subject: "Stats test",
        status: "clicked",
        campaignId,
        idempotencyKey: `campaign:${campaignId}:clicked@example.com`,
        sentAt: new Date(base.getTime() + 1000),
        deliveredAt: new Date(base.getTime() + 2000),
        openedAt: new Date(base.getTime() + 3000),
        clickedAt: new Date(base.getTime() + 4000),
      },
      // Sent only — the LATEST sentAt, so it drives lastSentAt.
      {
        templateKey: "stats-test-template",
        fromEmail: "from@hogsend.com",
        toEmail: "sent@example.com",
        subject: "Stats test",
        status: "sent",
        campaignId,
        idempotencyKey: `campaign:${campaignId}:sent@example.com`,
        sentAt: new Date(base.getTime() + 5000),
      },
      // Failed dispatch: no sentAt at all.
      {
        templateKey: "stats-test-template",
        fromEmail: "from@hogsend.com",
        toEmail: "failed@example.com",
        subject: "Stats test",
        status: "failed",
        campaignId,
        idempotencyKey: `campaign:${campaignId}:failed@example.com`,
      },
      // A suppressed send: campaign_id stamped but NO idempotency key at all
      // (suppression deliberately leaves the key unconsumed, and writes the
      // shared "failed" status) — only the FK attribution can see this row,
      // and only the missing key tells it apart from a dispatch failure.
      {
        templateKey: "stats-test-template",
        fromEmail: "from@hogsend.com",
        toEmail: "suppressed@example.com",
        subject: "Stats test",
        status: "failed",
        campaignId,
      },
      // A send belonging to the OTHER campaign — must not be counted.
      {
        templateKey: "stats-test-template",
        fromEmail: "from@hogsend.com",
        toEmail: "other@example.com",
        subject: "Stats test",
        status: "opened",
        campaignId: otherCampaignId,
        idempotencyKey: `campaign:${otherCampaignId}:other@example.com`,
        sentAt: new Date(base.getTime() + 9000),
        deliveredAt: new Date(base.getTime() + 9500),
        openedAt: new Date(base.getTime() + 9900),
      },
    ])
    .returning({ id: emailSends.id });
  createdSendIds = sendRows.map((r) => r.id);
});

afterAll(async () => {
  if (createdSendIds.length > 0) {
    await db.delete(emailSends).where(inArray(emailSends.id, createdSendIds));
  }
  if (campaignId) {
    await db.delete(campaigns).where(eq(campaigns.id, campaignId));
  }
  if (otherCampaignId) {
    await db.delete(campaigns).where(eq(campaigns.id, otherCampaignId));
  }
});

describe("GET /v1/admin/campaigns/:id/stats", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request(`/v1/admin/campaigns/${campaignId}/stats`);
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown campaign", async () => {
    const res = await app.request(
      "/v1/admin/campaigns/00000000-0000-0000-0000-000000000000/stats",
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(404);
  });

  it("aggregates engagement from the campaign's own sends only", async () => {
    const res = await app.request(`/v1/admin/campaigns/${campaignId}/stats`, {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // `sends` and `failed` exclude the keyless suppressed row (not a
    // dispatch attempt, despite its "failed" status); it is still attributed
    // — via the FK — as `skipped`.
    expect(body).toEqual({
      sends: 3,
      delivered: 1,
      opened: 1,
      clicked: 1,
      bounced: 0,
      complained: 0,
      failed: 1,
      skipped: 1,
      lastSentAt: new Date(base.getTime() + 5000).toISOString(),
    });
  });

  it("scopes the aggregate to the requested campaign", async () => {
    const res = await app.request(
      `/v1/admin/campaigns/${otherCampaignId}/stats`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sends).toBe(1);
    expect(body.opened).toBe(1);
    expect(body.clicked).toBe(0);
  });
});

describe("GET /v1/admin/emails?campaignId=", () => {
  it("lists all the campaign's sends, including keyless suppressed rows", async () => {
    const res = await app.request(
      `/v1/admin/emails?limit=100&campaignId=${campaignId}`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(4);
    const recipients = body.emails.map((e: { toEmail: string }) => e.toEmail);
    expect(recipients).toContain("clicked@example.com");
    expect(recipients).toContain("sent@example.com");
    expect(recipients).toContain("failed@example.com");
    expect(recipients).toContain("suppressed@example.com");
    expect(recipients).not.toContain("other@example.com");
  });

  it("composes with a status filter", async () => {
    const res = await app.request(
      `/v1/admin/emails?limit=100&campaignId=${campaignId}&status=failed`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // Suppression writes the same row-level "failed" status as a dispatch
    // failure, so the status filter surfaces both; the stats endpoint is
    // what tells them apart (by the missing idempotency key).
    expect(body.total).toBe(2);
    const recipients = body.emails.map((e: { toEmail: string }) => e.toEmail);
    expect(recipients).toContain("failed@example.com");
    expect(recipients).toContain("suppressed@example.com");
  });
});
