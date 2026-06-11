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

const { emailSends, linkClicks, trackedLinks } = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");
const { createApp, createHogsendClient, injectOpenPixel, rewriteLinks } =
  await import("@hogsend/engine");

const container = createHogsendClient();
const app = createApp(container);
const { db } = container;

let testEmailSendId: string;

beforeAll(async () => {
  const rows = await db
    .insert(emailSends)
    .values({
      fromEmail: "test@hogsend.com",
      toEmail: "user@example.com",
      subject: "Test email",
      status: "sent",
      sentAt: new Date(),
    })
    .returning({ id: emailSends.id });

  testEmailSendId = rows[0]?.id ?? "";
});

afterAll(async () => {
  if (testEmailSendId) {
    await db.delete(emailSends).where(eq(emailSends.id, testEmailSendId));
  }
});

describe("rewriteLinks", () => {
  it("rewrites http links in HTML", async () => {
    const html = '<a href="https://example.com/page">Click</a>';
    const result = await rewriteLinks({
      html,
      emailSendId: testEmailSendId,
      baseUrl: "https://api.hogsend.com",
      db,
    });

    expect(result).not.toContain("https://example.com/page");
    expect(result).toContain("https://api.hogsend.com/v1/t/c/");

    const rows = await db
      .select()
      .from(trackedLinks)
      .where(eq(trackedLinks.emailSendId, testEmailSendId));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.originalUrl === "https://example.com/page")).toBe(
      true,
    );
  });

  it("skips unsubscribe links", async () => {
    const html =
      '<a href="https://api.hogsend.com/v1/email/unsubscribe?token=abc">Unsub</a>';
    const result = await rewriteLinks({
      html,
      emailSendId: testEmailSendId,
      baseUrl: "https://api.hogsend.com",
      db,
    });

    expect(result).toContain("/v1/email/unsubscribe?token=abc");
    expect(result).not.toContain("/v1/t/c/");
  });

  it("handles HTML with no links", async () => {
    const html = "<p>No links here</p>";
    const result = await rewriteLinks({
      html,
      emailSendId: testEmailSendId,
      baseUrl: "https://api.hogsend.com",
      db,
    });

    expect(result).toBe(html);
  });
});

describe("rewriteLinks — semantic links", () => {
  it("lifts event + properties into the row and strips the data attributes", async () => {
    // JSON quotes arrive entity-escaped, exactly as React renders them.
    const html =
      '<a href="https://example.com/thanks" data-hs-event="nps.submitted" data-hs-props="{&quot;score&quot;:9}">9</a>';
    const result = await rewriteLinks({
      html,
      emailSendId: testEmailSendId,
      baseUrl: "https://api.hogsend.com",
      db,
    });

    expect(result).toContain("/v1/t/c/");
    expect(result).not.toContain("data-hs-event");
    expect(result).not.toContain("data-hs-props");

    const rows = await db
      .select()
      .from(trackedLinks)
      .where(eq(trackedLinks.event, "nps.submitted"));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.eventProperties).toEqual({ score: 9 });
    expect(rows[0]?.originalUrl).toBe("https://example.com/thanks");
  });

  it("does NOT collapse same-href links carrying different answers", async () => {
    const html = [
      '<a href="https://example.com/done" data-hs-event="checkin.answered" data-hs-props="{&quot;answer&quot;:&quot;yes&quot;}">Yes</a>',
      '<a href="https://example.com/done" data-hs-event="checkin.answered" data-hs-props="{&quot;answer&quot;:&quot;no&quot;}">No</a>',
      '<a href="https://example.com/done">plain</a>',
    ].join("");
    const result = await rewriteLinks({
      html,
      emailSendId: testEmailSendId,
      baseUrl: "https://api.hogsend.com",
      db,
    });

    const ids = [...result.matchAll(/\/v1\/t\/c\/([0-9a-f-]+)/g)].map(
      (m) => m[1],
    );
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);

    const rows = await db
      .select()
      .from(trackedLinks)
      .where(eq(trackedLinks.event, "checkin.answered"));
    const answers = rows.map((r) => r.eventProperties?.answer).sort();
    expect(answers).toEqual(["no", "yes"]);
  });

  it("rejects reserved event namespaces", async () => {
    const html =
      '<a href="https://example.com/x" data-hs-event="email.clicked">x</a>';
    await expect(
      rewriteLinks({
        html,
        emailSendId: testEmailSendId,
        baseUrl: "https://api.hogsend.com",
        db,
      }),
    ).rejects.toThrow(/reserved namespace/);
  });

  it("rejects unparseable properties", async () => {
    const html =
      '<a href="https://example.com/x" data-hs-event="my.event" data-hs-props="not json">x</a>';
    await expect(
      rewriteLinks({
        html,
        emailSendId: testEmailSendId,
        baseUrl: "https://api.hogsend.com",
        db,
      }),
    ).rejects.toThrow(/unparseable/);
  });

  it("rejects a semantic link without a trackable href", async () => {
    const html = '<a href="mailto:hi@x.com" data-hs-event="my.event">x</a>';
    await expect(
      rewriteLinks({
        html,
        emailSendId: testEmailSendId,
        baseUrl: "https://api.hogsend.com",
        db,
      }),
    ).rejects.toThrow(/absolute http/);
  });
});

describe("injectOpenPixel", () => {
  it("injects pixel before </body>", () => {
    const html = "<html><body><p>Hello</p></body></html>";
    const result = injectOpenPixel({
      html,
      emailSendId: "test-id-123",
      baseUrl: "https://api.hogsend.com",
    });

    expect(result).toContain(
      'src="https://api.hogsend.com/v1/t/o/test-id-123"',
    );
    expect(result.indexOf("img")).toBeLessThan(result.indexOf("</body>"));
  });

  it("appends pixel when no </body> tag exists", () => {
    const html = "<p>Hello</p>";
    const result = injectOpenPixel({
      html,
      emailSendId: "test-id-123",
      baseUrl: "https://api.hogsend.com",
    });

    expect(result).toContain(
      'src="https://api.hogsend.com/v1/t/o/test-id-123"',
    );
  });
});

describe("GET /v1/t/c/:id — click tracking", () => {
  let trackedLinkId: string;

  beforeAll(async () => {
    const rows = await db
      .insert(trackedLinks)
      .values({
        emailSendId: testEmailSendId,
        originalUrl: "https://example.com/destination",
      })
      .returning({ id: trackedLinks.id });

    trackedLinkId = rows[0]?.id ?? "";
  });

  it("redirects to original URL and records click", async () => {
    const res = await app.request(`/v1/t/c/${trackedLinkId}`, {
      redirect: "manual",
      headers: {
        "user-agent": "TestAgent/1.0",
        "x-forwarded-for": "1.2.3.4",
      },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/destination");

    const clicks = await db
      .select()
      .from(linkClicks)
      .where(eq(linkClicks.trackedLinkId, trackedLinkId));
    expect(clicks.length).toBeGreaterThanOrEqual(1);
    expect(clicks[0]?.ipAddress).toBe("1.2.3.4");
    expect(clicks[0]?.userAgent).toBe("TestAgent/1.0");

    const links = await db
      .select()
      .from(trackedLinks)
      .where(eq(trackedLinks.id, trackedLinkId));
    expect(links[0]?.clickCount).toBeGreaterThanOrEqual(1);
  });

  it("returns 302 fallback for unknown link ID", async () => {
    const res = await app.request(
      "/v1/t/c/00000000-0000-0000-0000-000000000000",
      { redirect: "manual" },
    );

    expect(res.status).toBe(302);
  });
});

describe("GET /v1/t/o/:id — open tracking", () => {
  it("returns 1x1 GIF and sets openedAt", async () => {
    const res = await app.request(`/v1/t/o/${testEmailSendId}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(res.headers.get("cache-control")).toContain("no-store");

    const body = await res.arrayBuffer();
    expect(body.byteLength).toBeGreaterThan(0);

    const rows = await db
      .select({ openedAt: emailSends.openedAt })
      .from(emailSends)
      .where(eq(emailSends.id, testEmailSendId));
    expect(rows[0]?.openedAt).not.toBeNull();
  });

  it("is idempotent (does not update openedAt on second request)", async () => {
    const beforeRows = await db
      .select({ openedAt: emailSends.openedAt })
      .from(emailSends)
      .where(eq(emailSends.id, testEmailSendId));
    const firstOpenedAt = beforeRows[0]?.openedAt;

    await app.request(`/v1/t/o/${testEmailSendId}`);

    const afterRows = await db
      .select({ openedAt: emailSends.openedAt })
      .from(emailSends)
      .where(eq(emailSends.id, testEmailSendId));
    expect(afterRows[0]?.openedAt?.getTime()).toBe(firstOpenedAt?.getTime());
  });
});
