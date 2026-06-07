import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// DB-touching test: point at the real docker TimescaleDB (the delivery task body
// opens its OWN `getDb()` connection from process.env.DATABASE_URL), overriding
// the vitest.config placeholder.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Delivery tunables are read at MODULE-IMPORT time inside `deliver-webhook.ts`
// (`const MAX_ATTEMPTS = Number(process.env... ?? 8)`), so they MUST be set
// before the dynamic `@hogsend/engine` import below. Shrink the retry envelope so
// the backoff math is deterministic and exhaustion is reachable in a unit test.
process.env.OUTBOUND_WEBHOOK_MAX_ATTEMPTS = "3";
process.env.OUTBOUND_WEBHOOK_BASE_DELAY_MS = "1000";
process.env.OUTBOUND_WEBHOOK_MAX_DELAY_MS = "60000";
process.env.OUTBOUND_WEBHOOK_TIMEOUT_MS = "5000";
process.env.OUTBOUND_WEBHOOK_STUCK_AFTER_MS = "300000";

// Config-preserving Hatchet mock (mirrors campaigns-dataplane.test.ts). The
// delivery + reaper tasks are module-level `hatchet.task({ name, fn })` built off
// the ENGINE's own `lib/hatchet.ts` at import. We mock BOTH the engine's hatchet
// (so importing `@hogsend/engine` never dials a live gRPC engine AND the task's
// `.fn` is preserved for direct invocation) AND the API's `../lib/hatchet.js`.
// The reaper re-drives via `deliverWebhookTask.run(...)`, so `run` forwards to the
// REAL delivery `.fn` (captured below) — that is how the reaper test exercises a
// real re-drive against the dev DB without a live engine.
const { hatchetMock } = vi.hoisted(() => {
  const ref: { fn: ((input: unknown) => unknown) | null } = { fn: null };
  const factory = () => ({
    hatchet: {
      durableTask: vi.fn((config: Record<string, unknown>) => ({
        ...config,
        run: vi.fn(),
        runNoWait: vi.fn(),
        runAndWait: vi.fn(),
      })),
      task: vi.fn((config: Record<string, unknown>) => {
        // Capture the delivery task's fn so the reaper's `.run` re-drives the real
        // body. The reaper task also passes through here, but only `deliver-webhook`
        // is re-driven, so binding the latest non-cron fn keyed by name is exact.
        if (config.name === "deliver-webhook") {
          ref.fn = config.fn as (input: unknown) => unknown;
        }
        return {
          ...config,
          run: vi.fn(async (input: unknown) => {
            // Reaper re-drive path: forward to the real delivery body.
            if (config.name === "deliver-webhook" && ref.fn) {
              return ref.fn(input);
            }
            return {};
          }),
          runNoWait: vi.fn(),
        };
      }),
      events: { push: vi.fn() },
      runs: { cancel: vi.fn(), get: vi.fn() },
      worker: vi.fn(),
    },
  });
  return { hatchetMock: factory };
});

vi.mock("../../../../packages/engine/src/lib/hatchet.ts", () => hatchetMock());
vi.mock("../lib/hatchet.js", () => hatchetMock());

const { deadLetterQueue, webhookDeliveries, webhookEndpoints } = await import(
  "@hogsend/db"
);
const { eq } = await import("drizzle-orm");
const {
  createHogsendClient,
  deliverWebhookTask,
  reapDueWebhookDeliveriesTask,
} = await import("@hogsend/engine");

// `deliverWebhookTask.fn` / `reapDueWebhookDeliveriesTask.fn` are the REAL task
// bodies (the config-preserving mock kept them). Both self-bootstrap db from
// process.env.DATABASE_URL.
const deliverTask = deliverWebhookTask as unknown as {
  fn: (input: { deliveryId: string }) => Promise<{
    status: string;
    reason?: string;
    attemptCount?: number;
    nextRetryAt?: string;
    responseStatus?: number;
    fastFail?: boolean;
  }>;
};
const reaperTask = reapDueWebhookDeliveriesTask as unknown as {
  fn: () => Promise<{ candidates: number; reDriven: number }>;
};

// The container is constructed so the engine's email/list/etc singletons exist;
// the delivery task itself only needs the DB connection, but building the client
// keeps parity with the other DB-backed suites.
const container = createHogsendClient();
const { db } = container;

const RUN = `owd-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
let endpointIds: string[] = [];

/** Insert a webhook endpoint and track it for cleanup. */
async function seedEndpoint(opts: {
  disabled?: boolean;
}): Promise<{ id: string; secret: string }> {
  const [row] = await db
    .insert(webhookEndpoints)
    .values({
      url: `https://example.com/${RUN}/sink`,
      secret: "whsec_dGVzdHNlY3JldGZvcndlYmhvb2tkZWxpdmVyeXRlc3Qx",
      secretPrefix: "whsec_dGVzd",
      eventTypes: ["contact.created"],
      disabled: opts.disabled ?? false,
    })
    .returning({ id: webhookEndpoints.id, secret: webhookEndpoints.secret });
  if (!row) throw new Error("failed to seed endpoint");
  endpointIds.push(row.id);
  return row;
}

/** Insert a pending delivery row for an endpoint. */
async function seedDelivery(opts: {
  endpointId: string;
  attemptCount?: number;
  status?: "pending" | "sending";
  nextRetryAt?: Date | null;
  updatedAt?: Date;
  webhookId?: string;
}): Promise<string> {
  const webhookId = opts.webhookId ?? `msg_${RUN}_${Math.random()}`;
  const [row] = await db
    .insert(webhookDeliveries)
    .values({
      endpointId: opts.endpointId,
      webhookId,
      eventType: "contact.created",
      payload: {
        id: webhookId,
        type: "contact.created",
        timestamp: new Date().toISOString(),
        data: { id: "c1", email: "a@b.com" },
      },
      status: opts.status ?? "pending",
      attemptCount: opts.attemptCount ?? 0,
      nextRetryAt:
        opts.nextRetryAt === undefined ? new Date() : opts.nextRetryAt,
      ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
    })
    .returning({ id: webhookDeliveries.id });
  if (!row) throw new Error("failed to seed delivery");
  return row.id;
}

async function getDelivery(id: string) {
  const [row] = await db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.id, id));
  return row;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  for (const id of endpointIds) {
    await db
      .delete(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, id));
    await db
      .delete(deadLetterQueue)
      .where(eq(deadLetterQueue.source, "webhook-delivery"));
    await db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, id));
  }
  endpointIds = [];
});

// ===========================================================================
// 2xx → delivered (TERMINAL) + lastDeliveryAt bumped
// ===========================================================================

describe("deliverWebhookTask — 2xx success", () => {
  it("marks the row delivered, signs the body, and bumps endpoint.lastDeliveryAt", async () => {
    const endpoint = await seedEndpoint({});
    const deliveryId = await seedDelivery({ endpointId: endpoint.id });

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response("ok", { status: 200 }) as unknown as Response,
      );

    const result = await deliverTask.fn({ deliveryId });
    expect(result.status).toBe("delivered");
    expect(result.responseStatus).toBe(200);

    // The POST carried the Standard Webhooks signed header set + the EXACT frozen
    // envelope bytes (never re-stringified between sign and send).
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchSpy.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(calledUrl).toBe(`https://example.com/${RUN}/sink`);
    expect(init.method).toBe("POST");
    expect(init.headers["Webhook-Id"]).toBeTruthy();
    expect(init.headers["Webhook-Signature"]).toMatch(/^v1,/);
    const row = await getDelivery(deliveryId);
    expect(typeof init.body).toBe("string");
    expect(init.body).toBe(JSON.stringify(row?.payload));

    expect(row?.status).toBe("delivered");
    expect(row?.deliveredAt).not.toBeNull();
    expect(row?.attemptCount).toBe(1);
    expect(row?.nextRetryAt).toBeNull();
    expect(row?.lastError).toBeNull();
    expect(row?.responseStatus).toBe(200);

    const [ep] = await db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, endpoint.id));
    expect(ep?.lastDeliveryAt).not.toBeNull();
  });
});

// ===========================================================================
// Retryable failure (5xx) with attempts remaining → pending + nextRetryAt
// ===========================================================================

describe("deliverWebhookTask — retryable failure schedules a backoff retry", () => {
  it("a 503 with attempts < MAX returns to pending with a future nextRetryAt", async () => {
    const endpoint = await seedEndpoint({});
    const deliveryId = await seedDelivery({ endpointId: endpoint.id });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("upstream down", { status: 503 }) as unknown as Response,
    );

    const before = Date.now();
    const result = await deliverTask.fn({ deliveryId });
    expect(result.status).toBe("pending");
    expect(result.attemptCount).toBe(1);

    const row = await getDelivery(deliveryId);
    expect(row?.status).toBe("pending");
    expect(row?.attemptCount).toBe(1);
    expect(row?.responseStatus).toBe(503);
    expect(row?.lastError).toContain("503");
    expect(row?.nextRetryAt).not.toBeNull();
    // backoffMs(1) = BASE*2 + jitter(0..BASE) → between 2s and 3s out (BASE=1s).
    const delayMs = (row?.nextRetryAt as Date).getTime() - before;
    expect(delayMs).toBeGreaterThanOrEqual(1900);
    expect(delayMs).toBeLessThanOrEqual(60000);
    // No DLQ row yet — only terminal failure dead-letters.
    const dlq = await db
      .select()
      .from(deadLetterQueue)
      .where(eq(deadLetterQueue.sourceId, deliveryId));
    expect(dlq).toHaveLength(0);
  });

  it("a network error (no HTTP status) is retryable and schedules a retry", async () => {
    const endpoint = await seedEndpoint({});
    const deliveryId = await seedDelivery({ endpointId: endpoint.id });

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await deliverTask.fn({ deliveryId });
    expect(result.status).toBe("pending");
    const row = await getDelivery(deliveryId);
    expect(row?.status).toBe("pending");
    expect(row?.responseStatus).toBeNull();
    expect(row?.lastError).toContain("ECONNREFUSED");
  });
});

// ===========================================================================
// Exhausted (attempts >= MAX) → failed (TERMINAL) + dead_letter_queue mirror
// ===========================================================================

describe("deliverWebhookTask — exhaustion dead-letters", () => {
  it("the MAX-th retryable failure marks the row failed and writes a DLQ row", async () => {
    const endpoint = await seedEndpoint({});
    // MAX_ATTEMPTS=3; seed with attemptCount=2 so this attempt becomes 3 (>= MAX).
    const deliveryId = await seedDelivery({
      endpointId: endpoint.id,
      attemptCount: 2,
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("still down", { status: 500 }) as unknown as Response,
    );

    const result = await deliverTask.fn({ deliveryId });
    expect(result.status).toBe("failed");
    expect(result.attemptCount).toBe(3);

    const row = await getDelivery(deliveryId);
    expect(row?.status).toBe("failed");
    expect(row?.nextRetryAt).toBeNull();
    expect(row?.attemptCount).toBe(3);

    // The DLQ mirror is the first real producer (decision 8): source +
    // sourceId(=deliveryId) + the forensic payload.
    const [dlq] = await db
      .select()
      .from(deadLetterQueue)
      .where(eq(deadLetterQueue.sourceId, deliveryId));
    expect(dlq).toBeDefined();
    expect(dlq?.source).toBe("webhook-delivery");
    expect(dlq?.status).toBe("pending");
    expect(dlq?.retryCount).toBe(3);
    expect(dlq?.error).toContain("Exhausted");
    const dlqPayload = dlq?.payload as {
      endpointId: string;
      eventType: string;
      webhookId: string;
    };
    expect(dlqPayload.endpointId).toBe(endpoint.id);
    expect(dlqPayload.eventType).toBe("contact.created");
  });

  it("a persistent 4xx (410 Gone) fast-fails after attempt >= 2 (no 8x burn)", async () => {
    const endpoint = await seedEndpoint({});
    // attemptCount=1 → this attempt becomes 2, tripping the fast-fail guard for a
    // non-retryable 4xx (410 is not 408/429/5xx).
    const deliveryId = await seedDelivery({
      endpointId: endpoint.id,
      attemptCount: 1,
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("gone", { status: 410 }) as unknown as Response,
    );

    const result = await deliverTask.fn({ deliveryId });
    expect(result.status).toBe("failed");
    expect(result.fastFail).toBe(true);
    expect(result.attemptCount).toBe(2); // did NOT burn to MAX

    const [dlq] = await db
      .select()
      .from(deadLetterQueue)
      .where(eq(deadLetterQueue.sourceId, deliveryId));
    expect(dlq).toBeDefined();
  });
});

// ===========================================================================
// Disabled / deleted endpoint → discarded (NOT an error, NOT dead-lettered)
// ===========================================================================

describe("deliverWebhookTask — operator-disabled endpoint discards", () => {
  it("a disabled endpoint discards the delivery without POSTing or dead-lettering", async () => {
    const endpoint = await seedEndpoint({ disabled: true });
    const deliveryId = await seedDelivery({ endpointId: endpoint.id });

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await deliverTask.fn({ deliveryId });
    expect(result.status).toBe("discarded");
    expect(fetchSpy).not.toHaveBeenCalled();

    const row = await getDelivery(deliveryId);
    expect(row?.status).toBe("discarded");
    expect(row?.nextRetryAt).toBeNull();

    // discarded is NOT an error → no DLQ row.
    const dlq = await db
      .select()
      .from(deadLetterQueue)
      .where(eq(deadLetterQueue.sourceId, deliveryId));
    expect(dlq).toHaveLength(0);
  });
});

// ===========================================================================
// Idempotency / terminal guard — a re-run of a terminal row does NOT re-POST
// ===========================================================================

describe("deliverWebhookTask — terminal-status guard (retry-safety)", () => {
  it("re-invoking a delivered row is a no-op (no duplicate POST)", async () => {
    const endpoint = await seedEndpoint({});
    const deliveryId = await seedDelivery({ endpointId: endpoint.id });

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response("ok", { status: 200 }) as unknown as Response,
      );

    await deliverTask.fn({ deliveryId });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // A duplicate/late enqueue (or a reaper re-drive that raced) must short-circuit
    // on the terminal status — no second POST.
    const result = await deliverTask.fn({ deliveryId });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("delivered");
  });

  it("returns skipped for a non-existent delivery id", async () => {
    const result = await deliverTask.fn({
      deliveryId: "00000000-0000-0000-0000-000000000000",
    });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("not_found");
  });
});

// ===========================================================================
// Reaper — re-drives due-pending + recovers stale-sending orphans
// ===========================================================================

describe("reapDueWebhookDeliveriesTask — retry scheduler + orphan recovery", () => {
  it("re-drives a due-pending row (nextRetryAt in the past) to delivery", async () => {
    const endpoint = await seedEndpoint({});
    const deliveryId = await seedDelivery({
      endpointId: endpoint.id,
      status: "pending",
      nextRetryAt: new Date(Date.now() - 60_000), // overdue
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }) as unknown as Response,
    );

    const result = await reaperTask.fn();
    expect(result.candidates).toBeGreaterThanOrEqual(1);
    expect(result.reDriven).toBeGreaterThanOrEqual(1);

    // The reaper drove the real delivery body (mock `.run` → captured fn) → 2xx.
    const row = await getDelivery(deliveryId);
    expect(row?.status).toBe("delivered");
  });

  it("recovers a stale `sending` orphan (updatedAt older than STUCK_AFTER_MS)", async () => {
    const endpoint = await seedEndpoint({});
    // A `sending` row whose worker died mid-POST: updatedAt is well past the
    // 5-min stuck window, so the reaper re-claims and re-drives it.
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    const deliveryId = await seedDelivery({
      endpointId: endpoint.id,
      status: "sending",
      nextRetryAt: null,
      updatedAt: stale,
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }) as unknown as Response,
    );

    const result = await reaperTask.fn();
    expect(result.reDriven).toBeGreaterThanOrEqual(1);

    const row = await getDelivery(deliveryId);
    expect(row?.status).toBe("delivered");
  });
});
