import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, emailSends, trackedLinks, userEvents } = await import(
  "@hogsend/db"
);
const { and, eq, inArray } = await import("drizzle-orm");
const { createApp, createHogsendClient } = await import("@hogsend/engine");

// Hatchet via the container override seam — the semantic flow pushes the
// consumer event through ingestEvent, whose hatchet.events.push must land on a
// spy (the fake test token cannot authenticate against hatchet-lite).
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

const container = createHogsendClient({
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db } = container;

const RUN = `sem-${Date.now()}`;
const SEMANTIC_EVENT = `survey.answered.${RUN}`;

async function insertSend(suffix: string) {
  const rows = await db
    .insert(emailSends)
    .values({
      fromEmail: "test@hogsend.com",
      toEmail: `${RUN}-${suffix}@example.com`,
      subject: "Semantic test email",
      status: "sent",
      sentAt: new Date(),
    })
    .returning({ id: emailSends.id, toEmail: emailSends.toEmail });
  const row = rows[0];
  if (!row) throw new Error("fixture insert failed");
  return row;
}

async function insertLink(
  emailSendId: string,
  url: string,
  semantic?: { event: string; properties: Record<string, unknown> },
) {
  const rows = await db
    .insert(trackedLinks)
    .values({
      emailSendId,
      originalUrl: url,
      event: semantic?.event,
      eventProperties: semantic?.properties,
    })
    .returning({ id: trackedLinks.id });
  const id = rows[0]?.id;
  if (!id) throw new Error("fixture insert failed");
  return id;
}

const sendIds: string[] = [];
const userKeys: string[] = [];

afterAll(async () => {
  if (userKeys.length > 0) {
    await db.delete(userEvents).where(inArray(userEvents.userId, userKeys));
    await db.delete(contacts).where(inArray(contacts.email, userKeys));
  }
  if (sendIds.length > 0) {
    // tracked_links + link_clicks cascade off email_sends.
    await db.delete(emailSends).where(inArray(emailSends.id, sendIds));
  }
});

describe("GET /v1/t/c/:id — semantic links", () => {
  it("emits the consumer event with properties on first answer", async () => {
    const send = await insertSend("first");
    sendIds.push(send.id);
    userKeys.push(send.toEmail);
    const yesId = await insertLink(send.id, "https://example.com/thanks", {
      event: SEMANTIC_EVENT,
      properties: { answer: "yes" },
    });

    const res = await app.request(`/v1/t/c/${yesId}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/thanks");

    // The semantic emit is fire-and-forget off the redirect path — poll.
    await vi.waitFor(async () => {
      const events = await db
        .select()
        .from(userEvents)
        .where(
          and(
            eq(userEvents.userId, send.toEmail),
            eq(userEvents.event, SEMANTIC_EVENT),
          ),
        );
      expect(events).toHaveLength(1);
      expect(events[0]?.properties).toMatchObject({
        answer: "yes",
        emailSendId: send.id,
        linkId: yesId,
      });
      expect(events[0]?.idempotencyKey).toBe(
        `sem:${send.id}:${SEMANTIC_EVENT}`,
      );
    });

    // The answering link is marked as the recorded answer.
    const links = await db
      .select({ semanticEmittedAt: trackedLinks.semanticEmittedAt })
      .from(trackedLinks)
      .where(eq(trackedLinks.id, yesId));
    expect(links[0]?.semanticEmittedAt).not.toBeNull();

    // And the consumer event reached the journey-routing push.
    expect(
      pushSpy.mock.calls.some(([eventName]) => eventName === SEMANTIC_EVENT),
    ).toBe(true);
  });

  it("first answer wins — a second different answer is deduped", async () => {
    const send = await insertSend("dedupe");
    sendIds.push(send.id);
    userKeys.push(send.toEmail);
    const yesId = await insertLink(send.id, "https://example.com/thanks", {
      event: SEMANTIC_EVENT,
      properties: { answer: "yes" },
    });
    const noId = await insertLink(send.id, "https://example.com/sorry", {
      event: SEMANTIC_EVENT,
      properties: { answer: "no" },
    });

    await app.request(`/v1/t/c/${yesId}`, { redirect: "manual" });
    await vi.waitFor(async () => {
      const events = await db
        .select()
        .from(userEvents)
        .where(
          and(
            eq(userEvents.userId, send.toEmail),
            eq(userEvents.event, SEMANTIC_EVENT),
          ),
        );
      expect(events).toHaveLength(1);
    });

    await app.request(`/v1/t/c/${noId}`, { redirect: "manual" });
    // Give the fire-and-forget pipeline time to (not) write the duplicate.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const events = await db
      .select()
      .from(userEvents)
      .where(
        and(
          eq(userEvents.userId, send.toEmail),
          eq(userEvents.event, SEMANTIC_EVENT),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0]?.properties).toMatchObject({ answer: "yes" });

    const noLink = await db
      .select({ semanticEmittedAt: trackedLinks.semanticEmittedAt })
      .from(trackedLinks)
      .where(eq(trackedLinks.id, noId));
    expect(noLink[0]?.semanticEmittedAt).toBeNull();
  });

  it("suppresses the semantic emit on a scanner-like click burst", async () => {
    const send = await insertSend("burst");
    sendIds.push(send.id);
    userKeys.push(send.toEmail);
    const plainIds = await Promise.all([
      insertLink(send.id, "https://example.com/a"),
      insertLink(send.id, "https://example.com/b"),
      insertLink(send.id, "https://example.com/c"),
    ]);
    const semanticId = await insertLink(send.id, "https://example.com/answer", {
      event: SEMANTIC_EVENT,
      properties: { answer: "yes" },
    });

    // A scanner follows every link within seconds.
    for (const id of plainIds) {
      await app.request(`/v1/t/c/${id}`, { redirect: "manual" });
    }
    const res = await app.request(`/v1/t/c/${semanticId}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);

    await new Promise((resolve) => setTimeout(resolve, 500));

    const events = await db
      .select()
      .from(userEvents)
      .where(
        and(
          eq(userEvents.userId, send.toEmail),
          eq(userEvents.event, SEMANTIC_EVENT),
        ),
      );
    expect(events).toHaveLength(0);

    const link = await db
      .select({ semanticEmittedAt: trackedLinks.semanticEmittedAt })
      .from(trackedLinks)
      .where(eq(trackedLinks.id, semanticId));
    expect(link[0]?.semanticEmittedAt).toBeNull();
  });
});
