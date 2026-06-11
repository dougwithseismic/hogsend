import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, emailSends, linkClicks, trackedLinks, userEvents } =
  await import("@hogsend/db");
const { and, eq, inArray } = await import("drizzle-orm");
const { confirmSemanticClick, createApp, createHogsendClient } = await import(
  "@hogsend/engine"
);

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
const { db, registry, logger } = container;

const deps = { db, hatchet: mockHatchet, registry, logger };

const RUN = `sem-${Date.now()}`;
const SEMANTIC_EVENT = `survey.answered.${RUN}`;

// A candidate click old enough that confirmSemanticClick's "wait out the
// remainder of the burst window" sleep is already over.
function staleClickedAt(): Date {
  return new Date(Date.now() - 45_000);
}

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
  sendIds.push(row.id);
  userKeys.push(row.toEmail);
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

async function insertClick(trackedLinkId: string, clickedAt: Date) {
  await db.insert(linkClicks).values({ trackedLinkId, clickedAt });
}

async function semanticEvents(userKey: string) {
  return db
    .select()
    .from(userEvents)
    .where(
      and(eq(userEvents.userId, userKey), eq(userEvents.event, SEMANTIC_EVENT)),
    );
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

describe("GET /v1/t/c/:id — semantic links defer confirmation", () => {
  it("redirects immediately and does NOT ingest the answer inline", async () => {
    const send = await insertSend("route");
    const linkId = await insertLink(send.id, "https://example.com/thanks", {
      event: SEMANTIC_EVENT,
      properties: { answer: "yes" },
    });

    const res = await app.request(`/v1/t/c/${linkId}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/thanks");

    // The answer is provisional — confirmation belongs to the deferred task,
    // so nothing semantic may land synchronously.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await semanticEvents(send.toEmail)).toHaveLength(0);

    // The raw click IS recorded.
    const clicks = await db
      .select()
      .from(linkClicks)
      .where(eq(linkClicks.trackedLinkId, linkId));
    expect(clicks.length).toBeGreaterThanOrEqual(1);
  });
});

describe("confirmSemanticClick", () => {
  it("confirms a clean answer: ingests, stamps, routes to journeys", async () => {
    const send = await insertSend("clean");
    const linkId = await insertLink(send.id, "https://example.com/thanks", {
      event: SEMANTIC_EVENT,
      properties: { answer: "yes" },
    });
    const clickedAt = staleClickedAt();
    await insertClick(linkId, clickedAt);

    const result = await confirmSemanticClick(deps, {
      trackedLinkId: linkId,
      clickedAt: clickedAt.toISOString(),
    });
    expect(result).toEqual({ status: "confirmed", event: SEMANTIC_EVENT });

    const events = await semanticEvents(send.toEmail);
    expect(events).toHaveLength(1);
    expect(events[0]?.properties).toMatchObject({
      answer: "yes",
      emailSendId: send.id,
      linkId,
    });
    expect(events[0]?.idempotencyKey).toBe(`sem:${send.id}:${SEMANTIC_EVENT}`);

    const links = await db
      .select({ semanticEmittedAt: trackedLinks.semanticEmittedAt })
      .from(trackedLinks)
      .where(eq(trackedLinks.id, linkId));
    expect(links[0]?.semanticEmittedAt).not.toBeNull();

    expect(
      pushSpy.mock.calls.some(([eventName]) => eventName === SEMANTIC_EVENT),
    ).toBe(true);
  });

  it("suppresses a scanner burst even when the SEMANTIC link is clicked first", async () => {
    const send = await insertSend("burst");
    const semanticId = await insertLink(send.id, "https://example.com/answer", {
      event: SEMANTIC_EVENT,
      properties: { answer: "yes" },
    });
    const plainIds = await Promise.all([
      insertLink(send.id, "https://example.com/a"),
      insertLink(send.id, "https://example.com/b"),
      insertLink(send.id, "https://example.com/c"),
    ]);

    // Realistic scan order: the scanner hits the semantic anchor FIRST, then
    // walks the rest of the email within seconds. The deferral means the
    // confirm runs with the WHOLE burst visible.
    const clickedAt = staleClickedAt();
    await insertClick(semanticId, clickedAt);
    for (const [i, id] of plainIds.entries()) {
      await insertClick(id, new Date(clickedAt.getTime() + (i + 1) * 2000));
    }

    const result = await confirmSemanticClick(deps, {
      trackedLinkId: semanticId,
      clickedAt: clickedAt.toISOString(),
    });
    expect(result).toMatchObject({ status: "suppressed" });

    expect(await semanticEvents(send.toEmail)).toHaveLength(0);
    const link = await db
      .select({ semanticEmittedAt: trackedLinks.semanticEmittedAt })
      .from(trackedLinks)
      .where(eq(trackedLinks.id, semanticId));
    expect(link[0]?.semanticEmittedAt).toBeNull();
  });

  it("first answer wins — a competing answer is lost", async () => {
    const send = await insertSend("dedupe");
    const yesId = await insertLink(send.id, "https://example.com/thanks", {
      event: SEMANTIC_EVENT,
      properties: { answer: "yes" },
    });
    const noId = await insertLink(send.id, "https://example.com/sorry", {
      event: SEMANTIC_EVENT,
      properties: { answer: "no" },
    });
    const yesClickedAt = staleClickedAt();
    // The "no" click is OUTSIDE the burst window around "yes" (and vice
    // versa), so neither confirmation is suppressed — this exercises the
    // answer-slot claim, not the burst gate.
    const noClickedAt = new Date(yesClickedAt.getTime() - 120_000);
    await insertClick(yesId, yesClickedAt);
    await insertClick(noId, noClickedAt);

    const first = await confirmSemanticClick(deps, {
      trackedLinkId: yesId,
      clickedAt: yesClickedAt.toISOString(),
    });
    expect(first.status).toBe("confirmed");

    const second = await confirmSemanticClick(deps, {
      trackedLinkId: noId,
      clickedAt: noClickedAt.toISOString(),
    });
    expect(second.status).toBe("lost");

    const events = await semanticEvents(send.toEmail);
    expect(events).toHaveLength(1);
    expect(events[0]?.properties).toMatchObject({ answer: "yes" });

    const noLink = await db
      .select({ semanticEmittedAt: trackedLinks.semanticEmittedAt })
      .from(trackedLinks)
      .where(eq(trackedLinks.id, noId));
    expect(noLink[0]?.semanticEmittedAt).toBeNull();
  });

  it("recovers a crashed earlier attempt of the same link (idempotent retry)", async () => {
    const send = await insertSend("retry");
    const linkId = await insertLink(send.id, "https://example.com/thanks", {
      event: SEMANTIC_EVENT,
      properties: { answer: "yes" },
    });
    const clickedAt = staleClickedAt();
    await insertClick(linkId, clickedAt);

    // Simulate a prior attempt that claimed the slot, then crashed before the
    // stamp: the user_events row exists (carrying THIS link's id) but
    // semantic_emitted_at is still NULL.
    await db.insert(userEvents).values({
      userId: send.toEmail,
      event: SEMANTIC_EVENT,
      properties: { answer: "yes", emailSendId: send.id, linkId },
      idempotencyKey: `sem:${send.id}:${SEMANTIC_EVENT}`,
    });

    const result = await confirmSemanticClick(deps, {
      trackedLinkId: linkId,
      clickedAt: clickedAt.toISOString(),
    });
    expect(result).toEqual({ status: "confirmed", event: SEMANTIC_EVENT });

    const links = await db
      .select({ semanticEmittedAt: trackedLinks.semanticEmittedAt })
      .from(trackedLinks)
      .where(eq(trackedLinks.id, linkId));
    expect(links[0]?.semanticEmittedAt).not.toBeNull();

    // Still exactly one stored answer.
    expect(await semanticEvents(send.toEmail)).toHaveLength(1);
  });
});
