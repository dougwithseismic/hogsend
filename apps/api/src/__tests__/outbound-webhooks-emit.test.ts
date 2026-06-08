import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// DB-touching test: point at the real docker TimescaleDB (emitOutbound selects
// endpoints + inserts deliveries against this connection), overriding the
// vitest.config placeholder DATABASE_URL.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Config-preserving Hatchet mock (mirrors buckets/campaigns tests). Mock BOTH the
// engine's own `lib/hatchet.ts` (so importing `@hogsend/engine` never dials a live
// gRPC engine) AND the API's `../lib/hatchet.js`. The delivery task's `runNoWait`
// — which `emitOutbound` calls fire-and-forget per inserted row — becomes a no-op
// `vi.fn()` spy via the `...config` spread, so the emit inserts the delivery row
// without dialing the broker.
const { runNoWaitSpy, hatchetMock } = vi.hoisted(() => {
  const runNoWait = vi.fn(async (_input: { deliveryId: string }) => ({}));
  const factory = () => ({
    hatchet: {
      durableTask: vi.fn((config: Record<string, unknown>) => ({
        ...config,
        run: vi.fn(),
        runNoWait: vi.fn(),
        runAndWait: vi.fn(),
      })),
      task: vi.fn((config: Record<string, unknown>) => ({
        ...config,
        run: vi.fn(),
        runNoWait,
      })),
      events: { push: vi.fn() },
      runs: { cancel: vi.fn(), get: vi.fn() },
      worker: vi.fn(),
    },
  });
  return { runNoWaitSpy: runNoWait, hatchetMock: factory };
});

vi.mock("../../../../packages/engine/src/lib/hatchet.ts", () => hatchetMock());
vi.mock("../lib/hatchet.js", () => hatchetMock());

const { webhookDeliveries, webhookEndpoints } = await import("@hogsend/db");
const { and, eq } = await import("drizzle-orm");
const { createHogsendClient, emitOutbound, WEBHOOK_EVENT_TYPES } = await import(
  "@hogsend/engine"
);

const container = createHogsendClient();
const { db, logger } = container;

// A throwaway mock Hatchet handed to emitOutbound as its `hatchet` arg. emit's
// own enqueue funnels through the module-level (mocked) deliverWebhookTask, so
// this object is only here to satisfy the signature.
const emitHatchet = {
  events: { push: vi.fn() },
} as unknown as Parameters<typeof emitOutbound>[0]["hatchet"];

const RUN = `owe-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
let endpointId = "";

/**
 * Seed ONE endpoint subscribed to ALL catalog events. emitOutbound's
 * `event_types @> '["<event>"]'` filter then matches every catalog event, so each
 * emit writes exactly one delivery row for this endpoint.
 */
beforeEach(async () => {
  runNoWaitSpy.mockClear();
  const [row] = await db
    .insert(webhookEndpoints)
    .values({
      url: `https://example.com/${RUN}/all`,
      secret: "whsec_dGVzdHNlY3JldGZvcmVtaXRwb2ludGNvdmVyYWdldGVzdA==",
      secretPrefix: "whsec_dGVzd",
      eventTypes: [...WEBHOOK_EVENT_TYPES],
      disabled: false,
    })
    .returning({ id: webhookEndpoints.id });
  endpointId = row?.id ?? "";
});

afterEach(async () => {
  if (endpointId) {
    await db
      .delete(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, endpointId));
    await db
      .delete(webhookEndpoints)
      .where(eq(webhookEndpoints.id, endpointId));
  }
  endpointId = "";
});

afterAll(async () => {
  await db
    .delete(webhookEndpoints)
    .where(eq(webhookEndpoints.url, `https://example.com/${RUN}/all`));
});

/** All delivery rows written for the seeded endpoint with a given eventType. */
async function deliveriesFor(eventType: string) {
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

// ===========================================================================
// Each catalog event enqueues exactly one delivery row with the right envelope
// ===========================================================================

describe("emitOutbound — one delivery row per subscribed endpoint per event", () => {
  it("contact.created enqueues a row whose payload is the signed envelope", async () => {
    await emitOutbound({
      db,
      hatchet: emitHatchet,
      logger,
      event: "contact.created",
      payload: {
        id: "c-1",
        externalId: "ext-1",
        email: "a@b.com",
        properties: { plan: "pro" },
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    const rows = await deliveriesFor("contact.created");
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.status).toBe("pending");
    expect(row?.attemptCount).toBe(0);
    // The webhookId == the envelope id == the future Webhook-Id header.
    expect(row?.webhookId).toMatch(/^msg_/);
    const envelope = row?.payload as {
      id: string;
      type: string;
      timestamp: string;
      data: { externalId: string; email: string };
    };
    expect(envelope.id).toBe(row?.webhookId);
    expect(envelope.type).toBe("contact.created");
    expect(typeof envelope.timestamp).toBe("string");
    expect(envelope.data.externalId).toBe("ext-1");
    expect(envelope.data.email).toBe("a@b.com");

    // Fire-and-forget enqueue of the durable delivery task for the inserted row.
    expect(runNoWaitSpy).toHaveBeenCalledTimes(1);
    expect(runNoWaitSpy.mock.calls[0]?.[0]?.deliveryId).toBe(row?.id);
  });

  it("writes a correctly-typed envelope for EVERY one of the 13 catalog events", async () => {
    // Drive each catalog event through emit with a minimal payload (the envelope
    // shape — id/type/timestamp/data — is identical across events; this proves no
    // catalog member is silently unroutable by the `@>` subscription filter).
    for (const event of WEBHOOK_EVENT_TYPES) {
      await emitOutbound({
        db,
        hatchet: emitHatchet,
        logger,
        event,
        // The payload type varies per event; a permissive object satisfies the
        // runtime path (no payload validation in emit — it is frozen verbatim).
        payload: { probe: event } as never,
        dedupeKey: `${RUN}:${event}`,
      });

      const rows = await deliveriesFor(event);
      expect(rows, `expected one delivery row for ${event}`).toHaveLength(1);
      const envelope = rows[0]?.payload as { type: string; data: unknown };
      expect(envelope.type).toBe(event);
      expect(envelope.data).toEqual({ probe: event });
    }

    // Every catalog event → one enqueue, one per inserted row.
    expect(runNoWaitSpy).toHaveBeenCalledTimes(WEBHOOK_EVENT_TYPES.length);
  });
});

// ===========================================================================
// Subscription filtering — an unsubscribed endpoint receives NOTHING
// ===========================================================================

describe("emitOutbound — only subscribed endpoints receive a delivery", () => {
  it("does NOT write a row for an event the endpoint is not subscribed to", async () => {
    // Re-scope the seeded endpoint to a single event, then emit a DIFFERENT one.
    await db
      .update(webhookEndpoints)
      .set({ eventTypes: ["contact.created"] })
      .where(eq(webhookEndpoints.id, endpointId));

    await emitOutbound({
      db,
      hatchet: emitHatchet,
      logger,
      event: "email.bounced",
      payload: {
        emailSendId: "es-1",
        resendId: "re-1",
        templateKey: null,
        userId: null,
        to: "x@y.com",
        at: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(await deliveriesFor("email.bounced")).toHaveLength(0);
    expect(runNoWaitSpy).not.toHaveBeenCalled();
  });

  it("does NOT write a row for a disabled endpoint", async () => {
    await db
      .update(webhookEndpoints)
      .set({ disabled: true })
      .where(eq(webhookEndpoints.id, endpointId));

    await emitOutbound({
      db,
      hatchet: emitHatchet,
      logger,
      event: "contact.created",
      payload: {
        id: "c-2",
        externalId: null,
        email: null,
        properties: {},
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(await deliveriesFor("contact.created")).toHaveLength(0);
  });
});

// ===========================================================================
// dedupeKey idempotency — a re-emit (Hatchet retry of a durable producer) is a
// no-op via the unique (endpointId, dedupeKey) index. This is the producer-side
// guard the bucket/journey/email-sent emit points rely on (risk 3).
// ===========================================================================

describe("emitOutbound — dedupeKey is the producer-side retry guard", () => {
  it("a second emit with the SAME dedupeKey does not insert a duplicate row", async () => {
    const dedupeKey = `bucket:${RUN}:user-1:entered:1`;
    const payload = {
      bucketId: "b1",
      bucketName: "VIP",
      userId: "user-1",
      userEmail: "u@e.com",
      transition: "entered" as const,
      entryCount: 1,
      source: "event",
    };

    await emitOutbound({
      db,
      hatchet: emitHatchet,
      logger,
      event: "bucket.entered",
      dedupeKey,
      payload,
    });
    await emitOutbound({
      db,
      hatchet: emitHatchet,
      logger,
      event: "bucket.entered",
      dedupeKey,
      payload,
    });

    // The unique (endpointId, dedupeKey) index absorbs the second emit → exactly
    // one row, and the second enqueue never fires (onConflictDoNothing returned
    // no inserted ids).
    const rows = await deliveriesFor("bucket.entered");
    expect(rows).toHaveLength(1);
    expect(runNoWaitSpy).toHaveBeenCalledTimes(1);
  });

  it("two emits WITHOUT a dedupeKey are never deduped (NULL keys are distinct)", async () => {
    const payload = {
      emailSendId: "es-2",
      resendId: "re-2",
      templateKey: "welcome",
      to: "n@e.com",
      userId: "u2",
      category: null,
      journeyStateId: null,
      subject: "Hi",
      sentAt: "2026-01-01T00:00:00.000Z",
    };
    // email.sent normally carries a dedupeKey, but this asserts the NULL-key
    // semantics of the partial unique index for non-retryable emit points.
    await emitOutbound({
      db,
      hatchet: emitHatchet,
      logger,
      event: "email.sent",
      payload,
    });
    await emitOutbound({
      db,
      hatchet: emitHatchet,
      logger,
      event: "email.sent",
      payload,
    });

    expect(await deliveriesFor("email.sent")).toHaveLength(2);
  });
});

// ===========================================================================
// Fire-and-forget — emitOutbound NEVER throws onto the producer's hot path
// (risk 2). A broken db/insert must be swallowed + logged, not propagated.
// ===========================================================================

describe("emitOutbound — never throws onto the hot path (fire-and-forget)", () => {
  it("swallows an internal failure and resolves (does not reject)", async () => {
    const warn = vi.fn();
    const brokenDb = {
      select() {
        throw new Error("db exploded selecting endpoints");
      },
    } as unknown as typeof db;

    // No `.catch` here on purpose — the spine's internal guard must make this
    // resolve. (Callers STILL wrap in `.catch` as defence-in-depth.)
    await expect(
      emitOutbound({
        db: brokenDb,
        hatchet: emitHatchet,
        logger: { ...logger, warn } as unknown as typeof logger,
        event: "contact.created",
        payload: {
          id: "c-3",
          externalId: null,
          email: null,
          properties: {},
          firstSeenAt: "2026-01-01T00:00:00.000Z",
          lastSeenAt: "2026-01-01T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
  });
});

// ===========================================================================
// open/click no-double-emit + bulk-import non-emit — static source guards.
//
// The open/click first-touch single-emitter behaviour and the import-contacts
// intentional non-emit are documented choke-point invariants (Open Risk 1 & 4).
// The DB-backed first-touch behaviour is covered by the tracking routes; here we
// pin the SOURCE invariants so a refactor that re-introduces a double-source or a
// per-row bulk emit is caught even without a live first-party tracking pixel.
// ===========================================================================

function engineSource(relativeFromEngineSrc: string): string {
  // apps/api/src/__tests__ → packages/engine/src
  const url = new URL(
    `../../../../packages/engine/src/${relativeFromEngineSrc}`,
    import.meta.url,
  );
  return readFileSync(fileURLToPath(url), "utf8");
}

describe("emit choke-point source invariants (Open Risk 1 & 4)", () => {
  it("the Resend provider webhook does NOT emit outbound for open/click (single-source)", () => {
    const mailer = engineSource("lib/mailer.ts");
    // The open/click branches update DB status only — they must NOT call
    // emitProviderEmailEvent (first-party pixel/redirect is the single emitter).
    expect(mailer).toMatch(/emitProviderEmailEvent\("email\.delivered"/);
    expect(mailer).toMatch(/emitProviderEmailEvent\("email\.bounced"/);
    expect(mailer).not.toMatch(/emitProviderEmailEvent\("email\.opened"/);
    expect(mailer).not.toMatch(/emitProviderEmailEvent\("email\.clicked"/);
  });

  it("first-party open/click emits are PER-HIT (no first-touch gate, no dedupeKey)", () => {
    const open = engineSource("routes/tracking/open.ts");
    const click = engineSource("routes/tracking/click.ts");
    // Owner decision 1: EVERY open/click must reach EVERY destination. The
    // first-touch gate (`opened.length > 0`) and the per-send dedupeKey
    // (`email.opened:<id>`) must be GONE so a NULL dedupe key makes each hit a
    // distinct delivery row. The first-touch openedAt/clickedAt UPDATE stays.
    expect(open).not.toMatch(/opened\.length > 0/);
    expect(open).not.toMatch(/email\.opened:/);
    expect(open).toMatch(/isNull\(emailSends\.openedAt\)/);
    expect(click).not.toMatch(/clicked\.length > 0/);
    expect(click).not.toMatch(/email\.clicked:/);
    expect(click).toMatch(/isNull\(emailSends\.clickedAt\)/);
  });

  it("the bulk import path does NOT emit contact.created per row (would flood)", () => {
    const importContacts = engineSource("workflows/import-contacts.ts");
    // import-contacts calls resolveOrCreateContact directly and intentionally
    // never emits (Open Risk 1, the known non-emit gap).
    expect(importContacts).toMatch(/resolveOrCreateContact/);
    expect(importContacts).not.toMatch(/emitOutbound/);
  });
});
