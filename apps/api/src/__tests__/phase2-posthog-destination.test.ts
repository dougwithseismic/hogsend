import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 2 — PostHog rides ONE durable path.
//
// This suite pins the three Phase-2 cutover invariants:
//  (1) no-double-emit — the first-party open/click re-push (pushTrackingEvent) no
//      longer fires a fire-and-forget PostHog captureEvent; PostHog now gets
//      opens/clicks PER-HIT via the kind="posthog" spine destination.
//  (2) the posthog adapter's optional per-destination event-name remap
//      (config.eventNames), defaulting to identity, used to map the canonical
//      "email.clicked" back to the legacy "email.link_clicked".
//  (3) the admin sendTest delivery routes THROUGH the per-kind adapter, so a
//      posthog endpoint test sends a VALID capture (non-null distinct_id), not a
//      malformed body.

// DB-touching test (the delivery task opens its OWN getDb() from process.env):
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Config-preserving Hatchet mock (mirrors outbound-webhooks-delivery.test.ts) so
// importing `@hogsend/engine` never dials a live gRPC engine AND the delivery
// task's real `.fn` is preserved for direct invocation.
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
        if (config.name === "deliver-webhook") {
          ref.fn = config.fn as (input: unknown) => unknown;
        }
        return {
          ...config,
          run: vi.fn(async (input: unknown) => {
            if (config.name === "deliver-webhook" && ref.fn) {
              return ref.fn(input);
            }
            return {};
          }),
          // The admin /test route does `runNoWait(...).catch(...)`, so this MUST
          // return a promise (a plain vi.fn() returns undefined → `.catch` throws
          // a 500). We drive the synthetic row through the real fn ourselves, so
          // this stays a no-op enqueue.
          runNoWait: vi.fn(async (_input: { deliveryId: string }) => ({})),
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

const { webhookDeliveries, webhookEndpoints } = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");
const { createApp, createHogsendClient, deliverWebhookTask } = await import(
  "@hogsend/engine"
);

const container = createHogsendClient();
const app = createApp(container);
const { db } = container;

const deliverTask = deliverWebhookTask as unknown as {
  fn: (input: { deliveryId: string }) => Promise<{
    status: string;
    responseStatus?: number;
  }>;
};

const ADMIN_HEADER = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
  "Content-Type": "application/json",
};

const RUN = `p2-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const endpointIds: string[] = [];

async function seedEndpoint(opts: {
  kind?: string;
  config?: Record<string, unknown> | null;
}): Promise<string> {
  const kind = opts.kind ?? "webhook";
  const secret =
    kind === "webhook"
      ? "whsec_dGVzdHNlY3JldGZvcnBoYXNlMnBvc3Rob2dkZXN0aW5h"
      : null;
  const secretPrefix = kind === "webhook" ? "whsec_dGVzd" : null;
  const [row] = await db
    .insert(webhookEndpoints)
    .values({
      url: `https://example.com/${RUN}/sink`,
      secret,
      secretPrefix,
      kind,
      config: opts.config ?? null,
      eventTypes: ["email.clicked"],
      disabled: false,
    })
    .returning({ id: webhookEndpoints.id });
  if (!row) throw new Error("failed to seed endpoint");
  endpointIds.push(row.id);
  return row.id;
}

/** Insert a pending delivery row carrying a frozen envelope. */
async function seedDelivery(opts: {
  endpointId: string;
  payload: Record<string, unknown>;
}): Promise<string> {
  const webhookId = `msg_${RUN}_${Math.random()}`;
  const [row] = await db
    .insert(webhookDeliveries)
    .values({
      endpointId: opts.endpointId,
      webhookId,
      eventType: String((opts.payload as { type?: string }).type ?? "unknown"),
      payload: opts.payload,
      status: "pending",
      attemptCount: 0,
      nextRetryAt: new Date(),
    })
    .returning({ id: webhookDeliveries.id });
  if (!row) throw new Error("failed to seed delivery");
  return row.id;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  for (const id of endpointIds) {
    await db
      .delete(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, id));
    await db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, id));
  }
});

// ===========================================================================
// (1) No-double-emit — opens/clicks no longer call captureEvent on the legacy
//     fire-and-forget path. PostHog gets them per-hit via the spine instead.
//     Pinned as a SOURCE invariant so a refactor that re-introduces the legacy
//     captureEvent is caught without a live PostHog/tracking pixel.
// ===========================================================================

function engineSource(relativeFromEngineSrc: string): string {
  const url = new URL(
    `../../../../packages/engine/src/${relativeFromEngineSrc}`,
    import.meta.url,
  );
  return readFileSync(fileURLToPath(url), "utf8");
}

describe("Phase 2 — no-double-emit (opens/clicks no longer captureEvent)", () => {
  it("pushTrackingEvent no longer references posthog/captureEvent or the param", () => {
    const src = engineSource("lib/tracking-events.ts");
    // The legacy fire-and-forget capture is GONE.
    expect(src).not.toMatch(/posthog\?\.captureEvent/);
    // The now-dead posthog param was dropped from the opts type + destructure.
    expect(src).not.toMatch(/posthog\?: PostHogService/);
    expect(src).not.toMatch(/PostHogService/);
    // The internal-bus re-push (journey routing) is KEPT.
    expect(src).toMatch(/await ingestEvent\(/);
  });

  it("the open + click routes no longer destructure analytics from the container", () => {
    const open = engineSource("routes/tracking/open.ts");
    // The click pipeline (shared by the UUID + vanity routes) owns the click
    // side effects — click.ts is a thin resolver now.
    const click = engineSource("routes/tracking/click-pipeline.ts");
    // The `analytics: posthog` destructure is removed — nothing passes posthog
    // into pushTrackingEvent anymore.
    expect(open).not.toMatch(/analytics: posthog/);
    expect(click).not.toMatch(/analytics: posthog/);
    // The per-hit outbound emit (the NEW PostHog path) stays.
    expect(open).toMatch(/event: "email\.opened"/);
    expect(click).toMatch(/event: "email\.clicked"/);
  });
});

// ===========================================================================
// (2) Event-name remap — config.eventNames translates envelope.type before the
//     capture body is built. Default is identity; the documented remap maps the
//     canonical "email.clicked" back to the legacy "email.link_clicked".
// ===========================================================================

describe("Phase 2 — posthog adapter event-name remap", () => {
  /** Drive one delivery through the real fn + capture the POSTed capture body. */
  async function captureBodyFor(opts: {
    config: Record<string, unknown>;
    type: string;
  }): Promise<{ event: string }> {
    const endpointId = await seedEndpoint({
      kind: "posthog",
      config: opts.config,
    });
    const deliveryId = await seedDelivery({
      endpointId,
      payload: {
        id: `msg_${opts.type}`,
        type: opts.type,
        timestamp: "2026-01-02T03:04:05.000Z",
        data: { userId: "u-1", to: "x@y.com", templateKey: "welcome" },
      },
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response("1", { status: 200 }) as unknown as Response,
      );
    const result = await deliverTask.fn({ deliveryId });
    expect(result.status).toBe("delivered");
    const [, init] = fetchSpy.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    return JSON.parse(init.body as string) as { event: string };
  }

  it("defaults to identity (no remap) when config.eventNames is absent", async () => {
    const body = await captureBodyFor({
      config: { apiKey: "phc_test" },
      type: "email.clicked",
    });
    expect(body.event).toBe("email.clicked");
  });

  it("maps email.clicked → email.link_clicked when configured (preserves insights)", async () => {
    const body = await captureBodyFor({
      config: {
        apiKey: "phc_test",
        eventNames: { "email.clicked": "email.link_clicked" },
      },
      type: "email.clicked",
    });
    expect(body.event).toBe("email.link_clicked");
  });

  it("passes through an unmapped event type unchanged", async () => {
    const body = await captureBodyFor({
      config: {
        apiKey: "phc_test",
        // Only email.clicked is remapped; email.opened must pass through.
        eventNames: { "email.clicked": "email.link_clicked" },
      },
      type: "email.opened",
    });
    expect(body.event).toBe("email.opened");
  });
});

// ===========================================================================
// (3) sendTest THROUGH the adapter — a posthog endpoint test produces a VALID
//     capture (non-null distinct_id from the synthetic identity), not a
//     malformed body. Driven via the admin /test route → real delivery fn.
// ===========================================================================

describe("Phase 2 — admin sendTest routes through the per-kind adapter", () => {
  it("a posthog endpoint test POSTs a valid capture with a non-null distinct_id", async () => {
    const endpointId = await seedEndpoint({
      kind: "posthog",
      config: { apiKey: "phc_test_key", host: "https://eu.i.posthog.com" },
    });

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response("1", { status: 200 }) as unknown as Response,
      );

    // Hit the admin test route — it inserts the synthetic webhook.test delivery
    // row, then enqueues the (mocked) deliverWebhookTask.runNoWait.
    const res = await app.request(`/v1/admin/webhooks/${endpointId}/test`, {
      method: "POST",
      headers: ADMIN_HEADER,
    });
    expect(res.status).toBe(202);

    // Drive the synthetic row through the REAL delivery fn (the route's enqueue
    // is mocked, so invoke the captured fn directly against the inserted row).
    const [delivery] = await db
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, endpointId));
    expect(delivery).toBeDefined();

    const result = await deliverTask.fn({ deliveryId: delivery?.id ?? "" });
    expect(result.status).toBe("delivered");

    // The adapter rewrote the request to the PostHog capture endpoint with a
    // valid body — NOT the malformed pre-adapter test envelope.
    const [calledUrl, init] = fetchSpy.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(calledUrl).toBe("https://eu.i.posthog.com/capture/");
    const body = JSON.parse(init.body as string) as {
      api_key: string;
      event: string;
      distinct_id: string;
      properties: Record<string, unknown>;
    };
    expect(body.api_key).toBe("phc_test_key");
    expect(body.event).toBe("webhook.test");
    // The synthetic identity makes distinct_id non-null (would be undefined and
    // the capture malformed if the test bypassed the adapter assumptions).
    expect(body.distinct_id).toBe(`test_${endpointId}`);
    expect(typeof body.distinct_id).toBe("string");
    expect(body.properties.$lib).toBe("hogsend");
    expect(body.properties.message).toBe("Hogsend test event");
  });

  it("a kind=webhook endpoint test still signs the synthetic envelope (no regression)", async () => {
    const endpointId = await seedEndpoint({ kind: "webhook" });

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response("ok", { status: 200 }) as unknown as Response,
      );

    const res = await app.request(`/v1/admin/webhooks/${endpointId}/test`, {
      method: "POST",
      headers: ADMIN_HEADER,
    });
    expect(res.status).toBe(202);

    const [delivery] = await db
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, endpointId));

    const result = await deliverTask.fn({ deliveryId: delivery?.id ?? "" });
    expect(result.status).toBe("delivered");

    const [calledUrl, init] = fetchSpy.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    // The signed POST goes to the raw endpoint.url with Standard-Webhooks headers.
    expect(calledUrl).toBe(`https://example.com/${RUN}/sink`);
    expect(init.headers["Webhook-Signature"]).toMatch(/^v1,/);
    // No PostHog-shaped fields leak into a signed webhook body.
    expect(init.body as string).not.toContain("api_key");
  });
});
