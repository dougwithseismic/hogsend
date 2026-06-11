import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, emailSends, trackedLinks, userEvents } = await import(
  "@hogsend/db"
);
const { and, eq, inArray, like } = await import("drizzle-orm");
const { createApp, createHogsendClient, rewriteLinks } = await import(
  "@hogsend/engine"
);

const pushSpy = vi.fn();
const mockHatchet = {
  durableTask: vi.fn(() => ({
    run: vi.fn(),
    runNoWait: vi.fn(),
    runAndWait: vi.fn(),
  })),
  task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
  events: { push: pushSpy },
  runs: { cancel: vi.fn(), get: vi.fn() },
  worker: vi.fn(),
} as unknown as HogsendClient["hatchet"];

const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const app = createApp(container);
const { db } = container;

const RUN = `ans-${Date.now()}`;
const EVENT = `checkin.answered.${RUN}`;

const sendIds: string[] = [];
const userKeys: string[] = [];

async function insertSend(suffix: string) {
  const rows = await db
    .insert(emailSends)
    .values({
      fromEmail: "test@hogsend.com",
      toEmail: `${RUN}-${suffix}@example.com`,
      subject: "Answer page test",
      status: "sent",
      sentAt: new Date(),
    })
    .returning({ id: emailSends.id, toEmail: emailSends.toEmail });
  const row = rows[0];
  if (!row) throw new Error("fixture insert failed");
  sendIds.push(row.id);
  userKeys.push(row.toEmail);
  return row;
}

afterAll(async () => {
  if (userKeys.length > 0) {
    await db.delete(userEvents).where(inArray(userEvents.userId, userKeys));
    await db.delete(contacts).where(inArray(contacts.email, userKeys));
  }
  if (sendIds.length > 0) {
    await db.delete(emailSends).where(inArray(emailSends.id, sendIds));
  }
});

describe("rewriteLinks — hosted answer sentinel", () => {
  it("resolves hogsend://answer to the engine answer page (own link id)", async () => {
    const send = await insertSend("sentinel");
    const html = `<a href="hogsend://answer" data-hs-event="${EVENT}" data-hs-props="{&quot;answer&quot;:&quot;yes&quot;}">Yes</a>`;
    const result = await rewriteLinks({
      html,
      emailSendId: send.id,
      baseUrl: "https://api.hogsend.com",
      db,
    });

    // The anchor is tracked like any link…
    expect(result).toContain("/v1/t/c/");
    expect(result).not.toContain("hogsend://answer");
    expect(result).not.toContain("data-hs-event");

    // …and the row's DESTINATION is the hosted page, keyed by its own id.
    const rows = await db
      .select({ id: trackedLinks.id, originalUrl: trackedLinks.originalUrl })
      .from(trackedLinks)
      .where(
        and(
          eq(trackedLinks.emailSendId, send.id),
          like(trackedLinks.originalUrl, "%/v1/t/a/%"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.originalUrl).toBe(
      `https://api.hogsend.com/v1/t/a/${rows[0]?.id}`,
    );
  });

  it("rejects the sentinel on a plain (non-semantic) link", async () => {
    const send = await insertSend("sentinel-plain");
    await expect(
      rewriteLinks({
        html: '<a href="hogsend://answer">nope</a>',
        emailSendId: send.id,
        baseUrl: "https://api.hogsend.com",
        db,
      }),
    ).rejects.toThrow(/only valid on a semantic link/);
  });
});

describe("GET/POST /v1/t/a/:id — hosted answer page", () => {
  it("renders the recorded answer with a comment form", async () => {
    const send = await insertSend("page");
    const rows = await db
      .insert(trackedLinks)
      .values({
        emailSendId: send.id,
        originalUrl: "https://api.hogsend.com/v1/t/a/self",
        event: EVENT,
        eventProperties: { answer: "yes" },
      })
      .returning({ id: trackedLinks.id });
    const linkId = rows[0]?.id ?? "";

    const res = await app.request(`/v1/t/a/${linkId}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("answer: yes");
    expect(html).toContain("<form");
  });

  it("404s for a non-semantic link id", async () => {
    const send = await insertSend("page-plain");
    const rows = await db
      .insert(trackedLinks)
      .values({ emailSendId: send.id, originalUrl: "https://example.com" })
      .returning({ id: trackedLinks.id });

    const res = await app.request(`/v1/t/a/${rows[0]?.id}`);
    expect(res.status).toBe(404);
  });

  it("ingests a comment as <event>.comment — first comment wins", async () => {
    const send = await insertSend("comment");
    const rows = await db
      .insert(trackedLinks)
      .values({
        emailSendId: send.id,
        originalUrl: "https://api.hogsend.com/v1/t/a/self",
        event: EVENT,
        eventProperties: { answer: "no" },
      })
      .returning({ id: trackedLinks.id });
    const linkId = rows[0]?.id ?? "";

    const post = (comment: string) =>
      app.request(`/v1/t/a/${linkId}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ comment }).toString(),
      });

    const first = await post("The setup wizard lost my config.");
    expect(first.status).toBe(200);

    const events = await db
      .select()
      .from(userEvents)
      .where(
        and(
          eq(userEvents.userId, send.toEmail),
          eq(userEvents.event, `${EVENT}.comment`),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0]?.properties).toMatchObject({
      comment: "The setup wizard lost my config.",
      parentEvent: EVENT,
      answer: "no",
    });

    // A second submission is a no-op (one comment per send + event).
    await post("Changed my mind, all fine actually.");
    const after = await db
      .select()
      .from(userEvents)
      .where(
        and(
          eq(userEvents.userId, send.toEmail),
          eq(userEvents.event, `${EVENT}.comment`),
        ),
      );
    expect(after).toHaveLength(1);
    expect(after[0]?.properties).toMatchObject({
      comment: "The setup wizard lost my config.",
    });
  });
});
