import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// DB-touching test (mirrors tracking.test.ts + outbound-webhooks-emit.test.ts):
// point at the real docker TimescaleDB so the click route's link_clicks insert,
// emailSends update, and emitOutbound's endpoint-select + delivery-insert all
// run against the same connection. Overrides the vitest.config placeholder.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Config-preserving Hatchet mock (mirrors outbound-webhooks-emit.test.ts). Mock
// BOTH the engine's own `lib/hatchet.ts` (so importing `@hogsend/engine` never
// dials a live gRPC engine) AND the API's `../lib/hatchet.js`. The click route
// enqueues the deliver-webhook task and (for semantic links) the confirm task
// fire-and-forget; the `...config` spread makes every `runNoWait` a no-op spy so
// the emit writes its delivery row WITHOUT dialing the broker.
const { hatchetMock } = vi.hoisted(() => {
  const factory = () => ({
    hatchet: {
      durableTask: vi.fn((config: Record<string, unknown>) => ({
        ...config,
        run: vi.fn(),
        runNoWait: vi.fn(async () => ({})),
        runAndWait: vi.fn(),
      })),
      task: vi.fn((config: Record<string, unknown>) => ({
        ...config,
        run: vi.fn(),
        runNoWait: vi.fn(async () => ({})),
      })),
      events: { push: vi.fn() },
      runs: { cancel: vi.fn(), get: vi.fn() },
      worker: vi.fn(),
    },
  });
  return { hatchetMock: factory };
});

vi.mock("../../../../packages/engine/src/lib/hatchet.ts", () => hatchetMock());
vi.mock("../lib/hatchet.js", () => hatchetMock());

const {
  emailSends,
  linkClicks,
  links,
  trackedLinks,
  webhookDeliveries,
  webhookEndpoints,
} = await import("@hogsend/db");
const { and, eq } = await import("drizzle-orm");
const { createApp, createHogsendClient, mintLink } = await import(
  "@hogsend/engine"
);

const container = createHogsendClient();
const app = createApp(container);
const { db, env } = container;

const RUN = `lte-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// ONE endpoint subscribed to BOTH click events. emitOutbound's
// `event_types @> '["<event>"]'` filter then writes exactly one delivery row
// per emitted event for this endpoint — letting us assert WHICH event fired by
// querying webhook_deliveries.eventType.
let endpointId = "";

// State to clean up.
const emailSendIds: string[] = [];
const trackedLinkIds: string[] = [];
const linkIds: string[] = [];

beforeAll(async () => {
  const [endpoint] = await db
    .insert(webhookEndpoints)
    .values({
      url: `https://example.com/${RUN}/clicks`,
      secret: "whsec_dGVzdHNlY3JldGZvcmVtaXRwb2ludGNvdmVyYWdldGVzdA==",
      secretPrefix: "whsec_dGVzd",
      // Subscribe to BOTH so we can prove which one the route emits.
      eventTypes: ["email.clicked", "link.clicked"],
      disabled: false,
    })
    .returning({ id: webhookEndpoints.id });
  endpointId = endpoint?.id ?? "";
});

afterAll(async () => {
  if (endpointId) {
    await db
      .delete(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, endpointId));
    await db
      .delete(webhookEndpoints)
      .where(eq(webhookEndpoints.id, endpointId));
  }
  for (const id of trackedLinkIds) {
    await db.delete(linkClicks).where(eq(linkClicks.trackedLinkId, id));
    await db.delete(trackedLinks).where(eq(trackedLinks.id, id));
  }
  for (const id of linkIds) {
    await db.delete(links).where(eq(links.id, id));
  }
  for (const id of emailSendIds) {
    await db.delete(emailSends).where(eq(emailSends.id, id));
  }
});

/** All delivery rows the seeded endpoint received for `eventType`. */
function deliveriesFor(eventType: string) {
  return db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.endpointId, endpointId),
        eq(webhookDeliveries.eventType, eventType),
      ),
    );
}

/**
 * Poll for a delivery row of `eventType`. The click route emits outbound
 * FIRE-AND-FORGET (`void`), so the delivery insert lands shortly after the 302
 * response resolves — wait for it rather than asserting on a race.
 */
async function waitForDelivery(
  eventType: string,
  { timeoutMs = 4000 } = {},
): Promise<Array<{ id: string }>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await deliveriesFor(eventType);
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
  return deliveriesFor(eventType);
}

describe("link-tracker EMAIL invariant — email path stays byte-for-byte", () => {
  // EMAIL path: a tracked_links row owned by an email send (email_send_id SET,
  // link_id NULL — exactly what `prepareTrackedHtml`/`rewriteLinks` produces).
  // The generic link-tracker extraction must NOT alter this path: the same
  // link_clicks insert, the same first-touch `emailSends.clickedAt`, and the
  // SAME `email.clicked` outbound (never the non-email `link.clicked`).
  it("an email-owned link records the click, marks clickedAt, and emits email.clicked (NOT link.clicked)", async () => {
    const [send] = await db
      .insert(emailSends)
      .values({
        fromEmail: "test@hogsend.com",
        toEmail: `${RUN}-email@example.com`,
        subject: "Invariant — email path",
        status: "sent",
        sentAt: new Date(),
      })
      .returning({ id: emailSends.id });
    const sendId = send?.id ?? "";
    emailSendIds.push(sendId);

    const [tl] = await db
      .insert(trackedLinks)
      .values({
        emailSendId: sendId,
        // link_id is NULL for the email path — it rewrites HTML at send time and
        // never mints a `links` row.
        linkId: null,
        originalUrl: "https://example.com/email-destination",
      })
      .returning({ id: trackedLinks.id });
    const tlId = tl?.id ?? "";
    trackedLinkIds.push(tlId);

    const res = await app.request(`/v1/t/c/${tlId}`, {
      redirect: "manual",
      headers: {
        "user-agent": "InvariantAgent/1.0",
        "x-forwarded-for": "9.9.9.9",
      },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://example.com/email-destination",
    );

    // EXACTLY ONE link_clicks row (the unconditional click record).
    const clicks = await db
      .select()
      .from(linkClicks)
      .where(eq(linkClicks.trackedLinkId, tlId));
    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.ipAddress).toBe("9.9.9.9");
    expect(clicks[0]?.userAgent).toBe("InvariantAgent/1.0");

    // clickCount incremented exactly once.
    const [tlAfter] = await db
      .select({ clickCount: trackedLinks.clickCount })
      .from(trackedLinks)
      .where(eq(trackedLinks.id, tlId));
    expect(tlAfter?.clickCount).toBe(1);

    // First-touch emailSends.clickedAt is SET (the email-only state write).
    const [sendAfter] = await db
      .select({ clickedAt: emailSends.clickedAt })
      .from(emailSends)
      .where(eq(emailSends.id, sendId));
    expect(sendAfter?.clickedAt).not.toBeNull();

    // The outbound is the EMAIL event — `email.clicked`, never `link.clicked`.
    const emailDeliveries = await waitForDelivery("email.clicked");
    expect(emailDeliveries.length).toBeGreaterThanOrEqual(1);
    const linkDeliveries = await deliveriesFor("link.clicked");
    expect(linkDeliveries).toHaveLength(0);
  });

  // PUBLIC path (the inverse): a standalone public link minted via `mintLink`
  // (link_id SET, email_send_id NULL). The extraction's parallel mint must emit
  // the catalogued `link.clicked` — NEVER a malformed `email.clicked` — and must
  // never touch any email send.
  it("a public mintLink'd standalone link emits link.clicked (NOT email.clicked) and touches no email send", async () => {
    const minted = await mintLink({
      db,
      url: "https://example.com/public-destination",
      baseUrl: env.API_PUBLIC_URL,
      source: "studio",
      type: "public",
      label: `${RUN}-public`,
      campaign: RUN,
    });
    linkIds.push(minted.linkId);
    trackedLinkIds.push(minted.trackedLinkId);

    // The minted tracked_links row owns a links row and has no email send.
    const [tlRow] = await db
      .select({
        emailSendId: trackedLinks.emailSendId,
        linkId: trackedLinks.linkId,
      })
      .from(trackedLinks)
      .where(eq(trackedLinks.id, minted.trackedLinkId));
    expect(tlRow?.emailSendId).toBeNull();
    expect(tlRow?.linkId).toBe(minted.linkId);

    const res = await app.request(`/v1/t/c/${minted.trackedLinkId}`, {
      redirect: "manual",
      headers: {
        "user-agent": "PublicAgent/1.0",
        "x-forwarded-for": "8.8.8.8",
      },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://example.com/public-destination",
    );

    // Click is still recorded (the spine counts every click, email or not).
    const clicks = await db
      .select()
      .from(linkClicks)
      .where(eq(linkClicks.trackedLinkId, minted.trackedLinkId));
    expect(clicks).toHaveLength(1);

    const [tlAfter] = await db
      .select({ clickCount: trackedLinks.clickCount })
      .from(trackedLinks)
      .where(eq(trackedLinks.id, minted.trackedLinkId));
    expect(tlAfter?.clickCount).toBe(1);

    // The outbound is the NON-email event — `link.clicked`, never `email.clicked`.
    const linkDeliveries = await waitForDelivery("link.clicked");
    expect(linkDeliveries.length).toBeGreaterThanOrEqual(1);

    // No email send was created or touched by a public click (it has none).
    const emailClicksDuringPublic = await deliveriesFor("email.clicked");
    // The only `email.clicked` delivery in this run is the one from the EMAIL
    // test above, scoped to ITS send — a public click adds none of its own.
    for (const d of emailClicksDuringPublic) {
      const data = (d.payload as { data?: { linkId?: string } }).data;
      expect(data?.linkId).not.toBe(minted.trackedLinkId);
    }
  });
});
