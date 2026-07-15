/**
 * Flow map LIVE layer (P4) — Redis publish + the admin SSE endpoint.
 *
 * Proves:
 *  a. `publishFlowTransition` — the ingest-hot-path publisher: unmapped events
 *     touch ZERO Redis, a classified event publishes with the previous node as
 *     `from` (null on a cold cache), a same-node repeat publishes nothing, and
 *     `campaign.arrived`'s `utm_campaign` caches the acquisition lane (empty /
 *     whitespace never caches).
 *  b. The ingest path — a POST /v1/events that classifies emits a real
 *     transition on `flow:transitions`, seen by a dedicated subscriber.
 *  c. The in-process token bucket caps PUBLISH volume and warns once.
 *  d. GET /v1/admin/flow/stream is an authed `text/event-stream` whose first
 *     frame is the `ready` event.
 *
 * Redis is REAL (docker on :6380 — REDIS_URL is overridden below so the engine
 * singleton points there). The `flow:transitions` channel is shared across
 * every process on that Redis, so every assertion filters to this run's
 * userIds.
 */
import type { HogsendClient, Logger } from "@hogsend/engine";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";
// The engine `getRedis()` singleton reads REDIS_URL lazily; point it at the
// docker Redis so the ingest hook (b) and the SSE subscriber (d) share it.
process.env.REDIS_URL = "redis://localhost:6380";

const { contacts, journeyStates, userEvents } = await import("@hogsend/db");
const { like } = await import("drizzle-orm");
const {
  createApp,
  createHogsendClient,
  defineSurface,
  publishFlowTransition,
  resetFlowLiveRateLimit,
  setFlowTopology,
  FLOW_TRANSITIONS_CHANNEL,
} = await import("@hogsend/engine");
type FlowTransitionMessage = import("@hogsend/engine").FlowTransitionMessage;

const mockHatchet = {
  durableTask: vi.fn(() => ({
    run: vi.fn(),
    runNoWait: vi.fn(),
    runAndWait: vi.fn(),
  })),
  task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
  events: { push: vi.fn() },
  runs: { cancel: vi.fn(), get: vi.fn() },
  worker: vi.fn(),
} as unknown as HogsendClient["hatchet"];

const RUN = `lflow-${Date.now()}`;

// Run-scoped surfaces: laneseed claims campaign.arrived (so the lane path is
// exercised), alpha/beta are prefix surfaces that give us two distinct nodes to
// transition between.
const LANESEED_ID = `${RUN}laneseed`;
const ALPHA_ID = `${RUN}alpha`;
const BETA_ID = `${RUN}beta`;
const LANESEED_NODE = `surface:${LANESEED_ID}`;
const ALPHA_NODE = `surface:${ALPHA_ID}`;
const BETA_NODE = `surface:${BETA_ID}`;
const ALPHA_PREFIX = `${RUN}.a.`;
const BETA_PREFIX = `${RUN}.b.`;

const surfaces = [
  defineSurface({
    id: LANESEED_ID,
    name: "Lane seed",
    tier: "acquisition",
    match: { events: ["campaign.arrived"] },
  }),
  defineSurface({
    id: ALPHA_ID,
    tier: "activation",
    match: { eventPrefix: ALPHA_PREFIX },
  }),
  defineSurface({
    id: BETA_ID,
    tier: "retention",
    match: { eventPrefix: BETA_PREFIX },
  }),
];

const container = createHogsendClient({
  surfaces,
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

// A dedicated ioredis for the tests (injected client + subscriber). Never the
// engine command singleton — a subscriber connection can't issue commands.
const redis = new Redis("redis://localhost:6380", {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
});
const logger = { warn: vi.fn() } as unknown as Logger;

beforeAll(async () => {
  await redis.connect();
  // Self-healing sweep: a killed run strands rows/keys that skew later runs.
  await db.delete(contacts).where(like(contacts.externalId, "lflow-%"));
  await db.delete(userEvents).where(like(userEvents.userId, "lflow-%"));
  await db.delete(journeyStates).where(like(journeyStates.userId, "lflow-%"));
});

afterAll(async () => {
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}%`));
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}%`));
  await db.delete(journeyStates).where(like(journeyStates.userId, `${RUN}%`));
  // Purge this run's live-state keys.
  const keys = [
    ...(await redis.keys(`flow:last:${RUN}*`)),
    ...(await redis.keys(`flow:lane:${RUN}*`)),
  ];
  if (keys.length > 0) await redis.del(...keys);
  redis.disconnect();
});

/** Publish one event through the real Redis, resetting the bucket first. */
async function publish(
  userKey: string,
  name: string,
  properties: Record<string, unknown> | null = null,
) {
  await publishFlowTransition({
    logger,
    userKey,
    contactId: `${userKey}-c`,
    event: {
      name,
      source: "test",
      properties,
      value: null,
      occurredAt: new Date(),
    },
    redis,
  });
}

describe("publishFlowTransition — the ingest publisher", () => {
  it("does ZERO Redis work for an unmapped event", async () => {
    const pipeSpy = vi.spyOn(redis, "pipeline");
    const pubSpy = vi.spyOn(redis, "publish");
    await publish(`${RUN}-unmapped`, `${RUN}.noise`);
    expect(pipeSpy).not.toHaveBeenCalled();
    expect(pubSpy).not.toHaveBeenCalled();
    pipeSpy.mockRestore();
    pubSpy.mockRestore();
  });

  it("publishes a first classified event with from:null and sets flow:last", async () => {
    const pubSpy = vi.spyOn(redis, "publish");
    const user = `${RUN}-first`;
    await publish(user, `${RUN}.a.hit`);
    expect(pubSpy).toHaveBeenCalledTimes(1);
    const msg = JSON.parse(pubSpy.mock.calls[0]?.[1] as string);
    expect(msg).toMatchObject({
      v: 1,
      userId: user,
      contactId: `${user}-c`,
      from: null,
      to: ALPHA_NODE,
      lane: null,
    });
    // flow:last was written by the same pipeline.
    expect(await redis.get(`flow:last:${user}`)).toBe(ALPHA_NODE);
    pubSpy.mockRestore();
  });

  it("carries the previous node as `from` on a different-node transition", async () => {
    const user = `${RUN}-chain`;
    await publish(user, `${RUN}.a.hit`); // → alpha (from null)
    const pubSpy = vi.spyOn(redis, "publish");
    await publish(user, `${RUN}.b.hit`); // → beta (from alpha)
    expect(pubSpy).toHaveBeenCalledTimes(1);
    const msg = JSON.parse(pubSpy.mock.calls[0]?.[1] as string);
    expect(msg).toMatchObject({ from: ALPHA_NODE, to: BETA_NODE });
    pubSpy.mockRestore();
  });

  it("publishes nothing when the node does not change", async () => {
    const user = `${RUN}-same`;
    await publish(user, `${RUN}.a.hit`); // → alpha (from null)
    const pubSpy = vi.spyOn(redis, "publish");
    await publish(user, `${RUN}.a.again`); // → alpha again: self-transition
    expect(pubSpy).not.toHaveBeenCalled();
    pubSpy.mockRestore();
  });

  it("caches the utm_campaign lane and carries it on later transitions", async () => {
    const user = `${RUN}-lane`;
    await publish(user, "campaign.arrived", {
      utm_campaign: `${RUN}-spring`,
    }); // → laneseed, caches lane
    const pubSpy = vi.spyOn(redis, "publish");
    await publish(user, `${RUN}.a.hit`); // → alpha, lane from cache
    const msg = JSON.parse(pubSpy.mock.calls[0]?.[1] as string);
    expect(msg).toMatchObject({
      from: LANESEED_NODE,
      to: ALPHA_NODE,
      lane: `${RUN}-spring`,
    });
    expect(await redis.get(`flow:lane:${user}`)).toBe(`${RUN}-spring`);
    pubSpy.mockRestore();
  });

  it("does not cache an empty / whitespace-only utm_campaign", async () => {
    const user = `${RUN}-lane-empty`;
    await publish(user, "campaign.arrived", { utm_campaign: "   " });
    expect(await redis.get(`flow:lane:${user}`)).toBeNull();
    const pubSpy = vi.spyOn(redis, "publish");
    await publish(user, `${RUN}.a.hit`);
    const msg = JSON.parse(pubSpy.mock.calls[0]?.[1] as string);
    expect(msg.lane).toBeNull();
    pubSpy.mockRestore();
  });
});

describe("token bucket", () => {
  it("caps PUBLISH volume and warns at most once", async () => {
    resetFlowLiveRateLimit();
    let published = 0;
    const warn = vi.fn();
    // Fake client: SET...GET returns null (cold), so every event is a genuine
    // from:null→alpha transition and would publish absent the bucket.
    const fake = {
      pipeline() {
        return {
          set() {
            return this;
          },
          get() {
            return this;
          },
          async exec() {
            return [
              [null, null],
              [null, null],
            ];
          },
        };
      },
      async publish() {
        published += 1;
        return 1;
      },
    } as unknown as Redis;
    const fakeLogger = { warn } as unknown as Logger;

    const FLOOD = 400;
    for (let i = 0; i < FLOOD; i++) {
      await publishFlowTransition({
        logger: fakeLogger,
        userKey: `${RUN}-flood-${i}`,
        contactId: "c",
        event: {
          name: `${RUN}.a.flood`,
          source: "test",
          properties: null,
          value: null,
          occurredAt: new Date(),
        },
        redis: fake,
      });
    }

    // Bucket capacity is 200; a tight synchronous flood refills at most a
    // couple of tokens, so publishes are firmly capped well under the flood.
    expect(published).toBeGreaterThanOrEqual(200);
    expect(published).toBeLessThan(220);
    expect(published).toBeLessThan(FLOOD);
    // One warn for the whole burst (once-per-minute).
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("ingest path → live transition", () => {
  it("emits a transition on flow:transitions for a classified POST /v1/events", async () => {
    resetFlowLiveRateLimit();
    const user = `${RUN}-ingest`;
    const messages: FlowTransitionMessage[] = [];
    const sub = new Redis("redis://localhost:6380", {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    await sub.connect();
    sub.on("message", (_ch, raw) => {
      try {
        const m = JSON.parse(raw) as FlowTransitionMessage;
        if (typeof m.userId === "string" && m.userId.startsWith(RUN)) {
          messages.push(m);
        }
      } catch {
        // ignore malformed
      }
    });
    await sub.subscribe(FLOW_TRANSITIONS_CHANNEL);

    const post = (name: string, props?: Record<string, unknown>) =>
      app.request("/v1/events", {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          userId: user,
          ...(props ? { eventProperties: props } : {}),
        }),
      });

    // Seed the lane, then two distinct-node transitions.
    expect(
      (await post("campaign.arrived", { utm_campaign: `${RUN}-fall` })).status,
    ).toBe(202);
    expect((await post(`${RUN}.a.hit`)).status).toBe(202);
    expect((await post(`${RUN}.b.hit`)).status).toBe(202);

    const found = await waitFor(
      messages,
      (m) => m.userId === user && m.to === BETA_NODE,
      5000,
    );
    expect(found).toMatchObject({
      from: ALPHA_NODE,
      to: BETA_NODE,
      lane: `${RUN}-fall`,
      contactId: expect.any(String),
    });

    await sub.unsubscribe(FLOW_TRANSITIONS_CHANNEL);
    sub.disconnect();
  });
});

describe("GET /v1/admin/flow/stream", () => {
  it("serves an authed text/event-stream whose first frame is `ready`", async () => {
    const controller = new AbortController();
    const res = await app.request(
      "/v1/admin/flow/stream",
      { headers: AUTH_HEADER, signal: controller.signal },
      // Provide the abort signal via RequestInit above.
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    const firstChunk = await readFirst(reader as ReadableStreamDefaultReader);
    expect(firstChunk).toContain("event: ready");
    // The ready payload carries the topology node ids (deploy-skew detection).
    expect(firstChunk).toContain(ALPHA_NODE);

    controller.abort();
    try {
      await reader?.cancel();
    } catch {
      // already aborted
    }
  });
});

// The engine caches an acquisition lane from `campaign.arrived` even when the
// event maps to NO node (the common case — few installs declare a `campaign.`
// surface), so the live path stays lane-parity with the windowed aggregate,
// which reads the utm from the DB regardless of classification. Exercising that
// branch needs a topology where `campaign.arrived` is UNMAPPED, so this block
// swaps the singleton to a bare surface set and restores it afterwards.
describe("unmapped campaign.arrived — lane caching (no node)", () => {
  const BARE_ID = `${RUN}bare`;
  const BARE_NODE = `surface:${BARE_ID}`;

  beforeAll(() => {
    // Building this client sets the flow-topology singleton to one that maps
    // `${RUN}.a.` but does NOT claim `campaign.arrived`.
    createHogsendClient({
      surfaces: [
        defineSurface({
          id: BARE_ID,
          tier: "activation",
          match: { eventPrefix: ALPHA_PREFIX },
        }),
      ],
      overrides: { hatchet: mockHatchet },
    });
  });

  afterAll(() => {
    // Restore the mapped topology for any later work sharing this module.
    setFlowTopology(container.flowTopology);
  });

  it("caches the lane via a bare SET (no pipeline, no publish), then a later mapped event carries it", async () => {
    const user = `${RUN}-uc-lane`;
    const pipeSpy = vi.spyOn(redis, "pipeline");
    const pubSpy = vi.spyOn(redis, "publish");

    // Unmapped campaign.arrived: caches the lane with a standalone SET — no
    // pipeline (there's no from-node to read), no publish (no node to ride).
    await publish(user, "campaign.arrived", { utm_campaign: `${RUN}-winter` });
    expect(pipeSpy).not.toHaveBeenCalled();
    expect(pubSpy).not.toHaveBeenCalled();
    expect(await redis.get(`flow:lane:${user}`)).toBe(`${RUN}-winter`);
    // It also left flow:last untouched, so the next event is still cold.
    expect(await redis.get(`flow:last:${user}`)).toBeNull();

    // A later MAPPED event publishes and carries the cached lane.
    await publish(user, `${RUN}.a.hit`);
    expect(pubSpy).toHaveBeenCalledTimes(1);
    const msg = JSON.parse(pubSpy.mock.calls[0]?.[1] as string);
    expect(msg).toMatchObject({
      from: null,
      to: BARE_NODE,
      lane: `${RUN}-winter`,
    });

    pipeSpy.mockRestore();
    pubSpy.mockRestore();
  });

  it("caches NOTHING for an empty / whitespace-only utm on the unmapped path", async () => {
    const user = `${RUN}-uc-empty`;
    const pipeSpy = vi.spyOn(redis, "pipeline");
    const setSpy = vi.spyOn(redis, "set");
    const pubSpy = vi.spyOn(redis, "publish");

    // Empty utm + unmapped node = zero Redis I/O and nothing cached.
    await publish(user, "campaign.arrived", { utm_campaign: "  " });
    expect(pipeSpy).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
    expect(pubSpy).not.toHaveBeenCalled();
    expect(await redis.get(`flow:lane:${user}`)).toBeNull();

    pipeSpy.mockRestore();
    setSpy.mockRestore();
    pubSpy.mockRestore();
  });
});

/** Poll a message buffer until `pred` matches or the timeout elapses. */
async function waitFor(
  buffer: FlowTransitionMessage[],
  pred: (m: FlowTransitionMessage) => boolean,
  timeoutMs: number,
): Promise<FlowTransitionMessage> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = buffer.find(pred);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out waiting for a flow transition");
}

/** Read stream chunks until one carries an SSE event line (or a short cap). */
async function readFirst(reader: ReadableStreamDefaultReader): Promise<string> {
  const decoder = new TextDecoder();
  let acc = "";
  for (let i = 0; i < 20; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    acc += decoder.decode(value, { stream: true });
    if (acc.includes("event:")) break;
  }
  return acc;
}
