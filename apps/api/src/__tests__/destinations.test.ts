import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 3 — public defineDestination() + presets.
//
// Three layers under test:
//  (A) PURE UNIT — defineDestination identity, the DestinationRegistry
//      (id→transform map, consumer-wins-on-collision), and destinationsFromEnv
//      preset loading (none / csv / "*" / absent, always-on webhook+posthog).
//  (B) E2E — a CUSTOM defineDestination() resolved through the REAL
//      deliverWebhookTask via the process registry, plus the `null`-skip path.

// DB-touching test (the delivery task opens its OWN getDb() from process.env),
// overriding the vitest.config placeholder — mirrors phase2-posthog-destination.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Config-preserving Hatchet mock (mirrors phase2-posthog-destination.test.ts):
// importing `@hogsend/engine` never dials a live gRPC engine, AND the delivery
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
const {
  createHogsendClient,
  defineDestination,
  deliverWebhookTask,
  DestinationRegistry,
  destinationsFromEnv,
  getDestinationRegistry,
  PRESET_DESTINATIONS,
  posthogDestination,
  resetDestinationRegistry,
  segmentDestination,
  setDestinationRegistry,
  slackDestination,
  webhookDestination,
} = await import("@hogsend/engine");

// Building the client installs the preset-only registry as the process
// singleton (the same path the API + worker take at boot).
const container = createHogsendClient();
const { db } = container;

const deliverTask = deliverWebhookTask as unknown as {
  fn: (input: { deliveryId: string }) => Promise<{
    status: string;
    skipped?: boolean;
    responseStatus?: number;
  }>;
};

const RUN = `p3-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const endpointIds: string[] = [];

async function seedEndpoint(opts: {
  kind: string;
  config?: Record<string, unknown> | null;
  url?: string;
  /** A signing secret — required when the resolved transform is the webhook
   * preset (svix throws on an empty secret). Keyed destinations leave it null. */
  secret?: string | null;
}): Promise<string> {
  const secret = opts.secret ?? null;
  const [row] = await db
    .insert(webhookEndpoints)
    .values({
      url: opts.url ?? `https://example.com/${RUN}/sink`,
      secret,
      secretPrefix: secret ? secret.slice(0, 12) : null,
      kind: opts.kind,
      config: opts.config ?? null,
      eventTypes: ["email.clicked"],
      disabled: false,
    })
    .returning({ id: webhookEndpoints.id });
  if (!row) throw new Error("failed to seed endpoint");
  endpointIds.push(row.id);
  return row.id;
}

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
  // Restore the container's preset-only registry for any later suite in-process.
  setDestinationRegistry(
    new DestinationRegistry(Object.values(PRESET_DESTINATIONS)),
  );
});

// ===========================================================================
// (A1) defineDestination identity + shape
// ===========================================================================

describe("defineDestination — identity + shape", () => {
  it("returns its argument unchanged (a validating identity fn)", () => {
    const def = defineDestination({
      meta: { id: "x-test", name: "X Test" },
      events: ["email.clicked"],
      transform: () => ({ url: "https://x", headers: {}, body: "{}" }),
    });
    expect(def.meta.id).toBe("x-test");
    expect(def.events).toEqual(["email.clicked"]);
    expect(typeof def.transform).toBe("function");
  });

  it("the shipped presets carry the expected ids", () => {
    expect(webhookDestination.meta.id).toBe("webhook");
    expect(posthogDestination.meta.id).toBe("posthog");
    expect(segmentDestination.meta.id).toBe("segment");
    expect(slackDestination.meta.id).toBe("slack");
    expect(Object.keys(PRESET_DESTINATIONS).sort()).toEqual([
      "posthog",
      "segment",
      "slack",
      "webhook",
    ]);
  });
});

// ===========================================================================
// (A1b) segment + slack preset transforms — pure unit (no DB / no delivery).
// The transform reads only `ctx.endpoint.config`/`url`, so a stub endpoint +
// no-op logger is a complete context. Mirrors the depth posthog gets via E2E.
// ===========================================================================

/** A minimal `DestinationCtx` for a pure transform unit test. */
function transformCtx(endpoint: {
  url?: string;
  config?: Record<string, unknown> | null;
}) {
  const noop = () => undefined;
  return {
    endpoint: {
      url: endpoint.url ?? "https://endpoint.example/sink",
      config: endpoint.config ?? null,
    },
    logger: { warn: noop, info: noop, error: noop, debug: noop },
  } as unknown as Parameters<typeof segmentDestination.transform>[1];
}

const SEGMENT_ENVELOPE = {
  id: "msg_seg_unit",
  type: "email.clicked",
  timestamp: "2026-01-02T03:04:05.000Z",
  data: { templateKey: "welcome", linkUrl: "https://x.example" },
} as const;

describe("segment preset — transform()", () => {
  it("builds the /v1/track URL, Basic auth header, and userId body", () => {
    const result = segmentDestination.transform(
      {
        ...SEGMENT_ENVELOPE,
        data: { ...SEGMENT_ENVELOPE.data, userId: "u-9" },
      },
      transformCtx({ config: { writeKey: "wk_123" } }),
    );
    if (!result) throw new Error("expected a request, got null");
    // Default host + the /v1/track path.
    expect(result.url).toBe("https://api.segment.io/v1/track");
    expect(result.method).toBe("POST");
    // HTTP Basic = base64("<writeKey>:") with an EMPTY password.
    expect(result.headers.Authorization).toBe(
      `Basic ${Buffer.from("wk_123:").toString("base64")}`,
    );
    expect(result.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(result.body) as {
      userId?: string;
      anonymousId?: string;
      event: string;
      messageId: string;
      timestamp: string;
      properties: Record<string, unknown>;
    };
    // A known userId attributes the call (no anonymousId branch).
    expect(body.userId).toBe("u-9");
    expect(body.anonymousId).toBeUndefined();
    expect(body.event).toBe("email.clicked");
    expect(body.messageId).toBe("msg_seg_unit");
    expect(body.timestamp).toBe("2026-01-02T03:04:05.000Z");
    expect(body.properties.$lib).toBe("hogsend");
  });

  it("falls back to anonymousId (= envelope.id) when no identity is present", () => {
    const result = segmentDestination.transform(
      { ...SEGMENT_ENVELOPE, data: {} },
      transformCtx({ config: { writeKey: "wk_123" } }),
    );
    if (!result) throw new Error("expected a request, got null");
    const body = JSON.parse(result.body) as {
      userId?: string;
      anonymousId?: string;
    };
    expect(body.userId).toBeUndefined();
    expect(body.anonymousId).toBe("msg_seg_unit");
  });

  it("prefers `to` then `userEmail` for identity when userId is absent", () => {
    const byTo = segmentDestination.transform(
      { ...SEGMENT_ENVELOPE, data: { to: "to@x.com", userEmail: "e@x.com" } },
      transformCtx({ config: { writeKey: "wk" } }),
    );
    if (!byTo) throw new Error("expected a request");
    expect((JSON.parse(byTo.body) as { userId?: string }).userId).toBe(
      "to@x.com",
    );
    const byEmail = segmentDestination.transform(
      { ...SEGMENT_ENVELOPE, data: { userEmail: "e@x.com" } },
      transformCtx({ config: { writeKey: "wk" } }),
    );
    if (!byEmail) throw new Error("expected a request");
    expect((JSON.parse(byEmail.body) as { userId?: string }).userId).toBe(
      "e@x.com",
    );
  });

  it("honours config.host (region/proxy override) + eventNames remap", () => {
    const result = segmentDestination.transform(
      { ...SEGMENT_ENVELOPE, data: { userId: "u-1" } },
      transformCtx({
        config: {
          writeKey: "wk",
          host: "https://events.eu1.segmentapis.com",
          eventNames: { "email.clicked": "Email Link Clicked" },
        },
      }),
    );
    if (!result) throw new Error("expected a request");
    expect(result.url).toBe("https://events.eu1.segmentapis.com/v1/track");
    expect((JSON.parse(result.body) as { event: string }).event).toBe(
      "Email Link Clicked",
    );
  });

  it("THROWS (non-retryable config error) when config.writeKey is missing", () => {
    expect(() =>
      segmentDestination.transform(SEGMENT_ENVELOPE, transformCtx({})),
    ).toThrow(/writeKey/);
    expect(() =>
      segmentDestination.transform(
        SEGMENT_ENVELOPE,
        transformCtx({ config: {} }),
      ),
    ).toThrow(/writeKey/);
  });
});

describe("slack preset — transform()", () => {
  it("resolves config.url OVER endpoint.url", () => {
    const result = slackDestination.transform(
      SEGMENT_ENVELOPE,
      transformCtx({
        url: "https://endpoint.example/ignored",
        config: { url: "https://hooks.slack.com/services/AAA/BBB/CCC" },
      }),
    );
    if (!result) throw new Error("expected a request");
    expect(result.url).toBe("https://hooks.slack.com/services/AAA/BBB/CCC");
    expect(result.method).toBe("POST");
    expect(result.headers["Content-Type"]).toBe("application/json");
  });

  it("falls back to endpoint.url when config.url is absent", () => {
    const result = slackDestination.transform(
      SEGMENT_ENVELOPE,
      transformCtx({ url: "https://hooks.slack.com/services/from/endpoint" }),
    );
    if (!result) throw new Error("expected a request");
    expect(result.url).toBe("https://hooks.slack.com/services/from/endpoint");
  });

  it("shapes the text block: *type* for `who` (template `key`)", () => {
    const result = slackDestination.transform(
      {
        ...SEGMENT_ENVELOPE,
        data: { to: "user@x.com", templateKey: "welcome" },
      },
      transformCtx({ config: { url: "https://hooks.slack.com/x" } }),
    );
    if (!result) throw new Error("expected a request");
    const body = JSON.parse(result.body) as { text: string };
    expect(body.text).toBe(
      "*email.clicked* for `user@x.com` (template `welcome`)",
    );
  });

  it("carries optional username + icon_emoji through to the Slack payload", () => {
    const result = slackDestination.transform(
      { ...SEGMENT_ENVELOPE, data: {} },
      transformCtx({
        config: {
          url: "https://hooks.slack.com/x",
          username: "Hogsend",
          iconEmoji: ":email:",
        },
      }),
    );
    if (!result) throw new Error("expected a request");
    const body = JSON.parse(result.body) as {
      text: string;
      username?: string;
      icon_emoji?: string;
    };
    expect(body.username).toBe("Hogsend");
    expect(body.icon_emoji).toBe(":email:");
    // `who`/template absent → bare event type only.
    expect(body.text).toBe("*email.clicked*");
  });

  it("THROWS (non-retryable config error) when neither config.url nor endpoint.url is usable", () => {
    expect(() =>
      slackDestination.transform(
        SEGMENT_ENVELOPE,
        transformCtx({ url: "", config: {} }),
      ),
    ).toThrow(/url/);
  });
});

// ===========================================================================
// (A2) DestinationRegistry — id map + consumer-wins-on-collision
// ===========================================================================

describe("DestinationRegistry", () => {
  it("resolves a destination by kind id and reports count", () => {
    const reg = new DestinationRegistry([
      webhookDestination,
      posthogDestination,
    ]);
    expect(reg.count()).toBe(2);
    expect(reg.get("webhook")?.meta.id).toBe("webhook");
    expect(reg.get("posthog")?.meta.id).toBe("posthog");
    expect(reg.get("does-not-exist")).toBeUndefined();
  });

  it("last-writer-wins on id collision (consumer overrides a preset)", () => {
    const override = defineDestination({
      meta: { id: "posthog", name: "Custom PostHog" },
      events: ["email.clicked"],
      transform: () => ({ url: "https://override", headers: {}, body: "{}" }),
    });
    // Preset first, consumer last — the container builds the array this way.
    const reg = new DestinationRegistry([posthogDestination, override]);
    expect(reg.count()).toBe(1);
    expect(reg.get("posthog")?.meta.name).toBe("Custom PostHog");
  });
});

// ===========================================================================
// (A3) destinationsFromEnv — preset loading
// ===========================================================================

describe("destinationsFromEnv", () => {
  const ids = (list: ReturnType<typeof destinationsFromEnv>): string[] =>
    list.map((d) => d.meta.id).sort();

  it("absent → the always-on set (webhook + posthog only)", () => {
    expect(
      ids(destinationsFromEnv({ ENABLED_DESTINATION_PRESETS: undefined })),
    ).toEqual(["posthog", "webhook"]);
  });

  it('"none" → STILL the always-on set (never disables the no-regression presets)', () => {
    expect(
      ids(destinationsFromEnv({ ENABLED_DESTINATION_PRESETS: "none" })),
    ).toEqual(["posthog", "webhook"]);
  });

  it('"*" → every shipped preset', () => {
    expect(
      ids(destinationsFromEnv({ ENABLED_DESTINATION_PRESETS: "*" })),
    ).toEqual(["posthog", "segment", "slack", "webhook"]);
  });

  it("a csv allow-list is UNIONed with the always-on set", () => {
    expect(
      ids(destinationsFromEnv({ ENABLED_DESTINATION_PRESETS: "segment" })),
    ).toEqual(["posthog", "segment", "webhook"]);
    expect(
      ids(
        destinationsFromEnv({ ENABLED_DESTINATION_PRESETS: "slack,segment" }),
      ),
    ).toEqual(["posthog", "segment", "slack", "webhook"]);
  });

  it("ignores unknown ids in the csv (still returns the always-on set)", () => {
    expect(
      ids(destinationsFromEnv({ ENABLED_DESTINATION_PRESETS: "bogus" })),
    ).toEqual(["posthog", "webhook"]);
  });
});

// ===========================================================================
// (B1) Custom destination end-to-end through the REAL delivery task via the
//      process registry.
// ===========================================================================

describe("custom destination — end-to-end through deliverWebhookTask", () => {
  it("resolves the consumer's transform by kind and POSTs its exact request", async () => {
    // A custom destination keyed "crm". It rewrites url/headers/body from the
    // frozen envelope + endpoint.config — the same contract a preset uses.
    const crm = defineDestination({
      meta: { id: "crm", name: "Acme CRM" },
      events: ["email.clicked"],
      transform: (envelope, ctx) => {
        const cfg = (ctx.endpoint.config ?? {}) as { token?: string };
        return {
          url: "https://crm.example/ingest",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.token ?? ""}`,
          },
          body: JSON.stringify({
            event: envelope.type,
            at: envelope.timestamp,
          }),
        };
      },
    });

    // Install a registry containing the presets + the custom destination (the
    // exact array shape createHogsendClient builds: presets then consumer).
    setDestinationRegistry(
      new DestinationRegistry([...Object.values(PRESET_DESTINATIONS), crm]),
    );

    const endpointId = await seedEndpoint({
      kind: "crm",
      config: { token: "secret-token" },
    });
    const deliveryId = await seedDelivery({
      endpointId,
      payload: {
        id: "msg_crm_1",
        type: "email.clicked",
        timestamp: "2026-01-02T03:04:05.000Z",
        data: { userId: "u-1", to: "x@y.com" },
      },
    });

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }) as Response);

    const result = await deliverTask.fn({ deliveryId });
    expect(result.status).toBe("delivered");

    const [calledUrl, init] = fetchSpy.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(calledUrl).toBe("https://crm.example/ingest");
    expect(init.headers.Authorization).toBe("Bearer secret-token");
    const body = JSON.parse(init.body as string) as { event: string };
    expect(body.event).toBe("email.clicked");
  });

  it("segment preset E2E: POSTs the /v1/track call with Basic auth through the real task", async () => {
    // The preset-only registry installed by createHogsendClient already carries
    // segment (it is shipped). No custom registry needed — drive a kind=segment
    // endpoint through the real delivery fn end-to-end (the depth posthog gets).
    setDestinationRegistry(
      new DestinationRegistry(Object.values(PRESET_DESTINATIONS)),
    );

    const endpointId = await seedEndpoint({
      kind: "segment",
      config: { writeKey: "wk_e2e" },
    });
    const deliveryId = await seedDelivery({
      endpointId,
      payload: {
        id: "msg_seg_e2e",
        type: "email.clicked",
        timestamp: "2026-01-02T03:04:05.000Z",
        data: { userId: "u-seg", to: "x@y.com", templateKey: "welcome" },
      },
    });

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 200 }) as Response);

    const result = await deliverTask.fn({ deliveryId });
    expect(result.status).toBe("delivered");

    const [calledUrl, init] = fetchSpy.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(calledUrl).toBe("https://api.segment.io/v1/track");
    expect(init.headers.Authorization).toBe(
      `Basic ${Buffer.from("wk_e2e:").toString("base64")}`,
    );
    const body = JSON.parse(init.body as string) as {
      userId: string;
      event: string;
      messageId: string;
    };
    expect(body.userId).toBe("u-seg");
    expect(body.event).toBe("email.clicked");
    expect(body.messageId).toBe("msg_seg_e2e");
  });

  it("segment preset E2E: a missing writeKey DLQs (thrown config error, no POST)", async () => {
    setDestinationRegistry(
      new DestinationRegistry(Object.values(PRESET_DESTINATIONS)),
    );

    const endpointId = await seedEndpoint({ kind: "segment", config: {} });
    const deliveryId = await seedDelivery({
      endpointId,
      payload: {
        id: "msg_seg_nokey",
        type: "email.clicked",
        timestamp: "2026-01-02T03:04:05.000Z",
        data: { userId: "u-x" },
      },
    });

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 200 }) as Response);

    const result = await deliverTask.fn({ deliveryId });
    // A thrown transform is a non-retryable permanent failure: the row goes
    // terminal `failed` (with a forensic dead_letter_queue mirror), NOT a retry.
    expect(result.status).toBe("failed");
    // No HTTP request was made — the request was never built.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("slack preset E2E: POSTs the formatted text block to config.url through the real task", async () => {
    setDestinationRegistry(
      new DestinationRegistry(Object.values(PRESET_DESTINATIONS)),
    );

    const endpointId = await seedEndpoint({
      kind: "slack",
      url: `https://example.com/${RUN}/ignored-endpoint-url`,
      config: { url: "https://hooks.slack.com/services/AAA/BBB/CCC" },
    });
    const deliveryId = await seedDelivery({
      endpointId,
      payload: {
        id: "msg_slack_e2e",
        type: "email.clicked",
        timestamp: "2026-01-02T03:04:05.000Z",
        data: { to: "user@x.com", templateKey: "welcome" },
      },
    });

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }) as Response);

    const result = await deliverTask.fn({ deliveryId });
    expect(result.status).toBe("delivered");

    const [calledUrl, init] = fetchSpy.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    // config.url wins over endpoint.url.
    expect(calledUrl).toBe("https://hooks.slack.com/services/AAA/BBB/CCC");
    const body = JSON.parse(init.body as string) as { text: string };
    expect(body.text).toBe(
      "*email.clicked* for `user@x.com` (template `welcome`)",
    );
  });

  it("a transform returning null SKIPS delivery (delivered no-op, no POST)", async () => {
    const filtered = defineDestination({
      meta: { id: "filtered", name: "Filtered" },
      events: ["email.clicked"],
      // Skip every event for this destination.
      transform: () => null,
    });

    setDestinationRegistry(
      new DestinationRegistry([
        ...Object.values(PRESET_DESTINATIONS),
        filtered,
      ]),
    );

    const endpointId = await seedEndpoint({ kind: "filtered" });
    const deliveryId = await seedDelivery({
      endpointId,
      payload: {
        id: "msg_filtered_1",
        type: "email.clicked",
        timestamp: "2026-01-02T03:04:05.000Z",
        data: { userId: "u-2" },
      },
    });

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }) as Response);

    const result = await deliverTask.fn({ deliveryId });
    expect(result.status).toBe("delivered");
    expect(result.skipped).toBe(true);
    // No HTTP request was made for a skipped delivery.
    expect(fetchSpy).not.toHaveBeenCalled();

    // The row is terminal (delivered) with no responseStatus.
    const [stored] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId));
    expect(stored?.status).toBe("delivered");
    expect(stored?.responseStatus).toBeNull();
  });

  it("an unknown kind falls back to the always-on webhook preset (signed POST)", async () => {
    // Reset to the process default (no custom registry) so an unregistered kind
    // resolves the fallback chain in the delivery task.
    resetDestinationRegistry();
    expect(getDestinationRegistry().get("webhook")?.meta.id).toBe("webhook");

    const endpointId = await seedEndpoint({
      kind: "totally-unregistered-kind",
      url: `https://example.com/${RUN}/unknown`,
      // The fallback is the webhook preset, which signs — needs a real secret.
      secret: "whsec_dGVzdHNlY3JldGZvcnAzZmFsbGJhY2t1bmtub3du",
    });
    const deliveryId = await seedDelivery({
      endpointId,
      payload: {
        id: "msg_unknown_1",
        type: "email.clicked",
        timestamp: "2026-01-02T03:04:05.000Z",
        data: { userId: "u-3" },
      },
    });

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }) as Response);

    const result = await deliverTask.fn({ deliveryId });
    expect(result.status).toBe("delivered");

    const [calledUrl, init] = fetchSpy.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    // Fell back to the webhook preset → signed POST to the raw endpoint url.
    expect(calledUrl).toBe(`https://example.com/${RUN}/unknown`);
    expect(init.headers["Webhook-Signature"]).toMatch(/^v1,/);
  });
});
