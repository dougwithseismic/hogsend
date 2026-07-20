/**
 * Journey-level email-preference category (`JourneyMeta.category`).
 *
 * A journey may stamp its own `email_preferences` category on every `sendEmail`
 * — it OVERRIDES the template's own category at send time exactly as the
 * hardcoded `"journey"` default did. Two concerns are pinned here:
 *
 *  1. BOOT validation (fail-CLOSED): a journey `category` runs through the SAME
 *     container boot guard as a template `category` — unknown / channel /
 *     consent-flipping (opt-in excluded) categories THROW; an opt-out excluded
 *     list WARNs; a valid topic list or reserved built-in boots. A CHANNEL
 *     preference list (kind:"channel") is rejected for BOTH journeys and
 *     templates (it gates a delivery transport, not an email topic).
 *  2. SEND-TIME (real Postgres): the journey category reaches
 *     `email_sends.category` and gates suppression through the SAME opt-in
 *     polarity a template category does — a not-opted-in recipient of an opt-in
 *     category gets an `unsubscribed`/failed row, an opted-in one gets a `sent`
 *     row stamped with the journey category; a journey with NO category still
 *     stamps the built-in `"journey"` default (regression).
 *
 * The send-time half drives the REAL `defineJourney` durable-task `fn` against
 * the Docker Postgres on :5434 (mirrors journey-suppress.test.ts): real
 * `createTrackedMailer`, a spy provider, real preference reads. Only the Hatchet
 * client is mocked (to capture `fn`).
 */

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the durable-task `fn` passed to `defineJourney` so we can drive it
// directly (mirrors journey-suppress.test.ts). The holder is `mock`-prefixed so
// vitest allows the hoisted mock factory to close over it.
type CapturedFn = (input: unknown, ctx: unknown) => Promise<unknown>;
const mockFnHolder: { fn: CapturedFn | undefined } = { fn: undefined };
vi.mock("../../../../packages/engine/src/lib/hatchet.js", () => ({
  hatchet: {
    durableTask: vi.fn((cfg: { fn: CapturedFn }) => {
      mockFnHolder.fn = cfg.fn;
      return { run: vi.fn(), runNoWait: vi.fn(), runAndWait: vi.fn() };
    }),
    task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
    events: { push: vi.fn(async () => {}) },
    runs: { cancel: vi.fn(async () => {}), get: vi.fn() },
    worker: vi.fn(),
  },
}));

const { contacts, emailPreferences, emailSends, journeyStates, userEvents } =
  await import("@hogsend/db");
const { eq, inArray } = await import("drizzle-orm");
const {
  buildListRegistry,
  createHogsendClient,
  createTrackedMailer,
  days,
  defineConnectorAction,
  defineJourney,
  defineList,
  sendEmail,
  setEmailService,
  setJourneyRegistry,
  synthesizeChannelLists,
} = await import("@hogsend/engine");
type EmailProvider = import("@hogsend/engine").EmailProvider;
const { JourneyRegistry } = await import("@hogsend/core/registry");
const { templates } = await import("../emails/index.js");
// The real app's `product-updates` list (opt-in, defaultOptIn:false) — the topic
// list this suite stamps on a journey.
const { productUpdates } = await import("../lists/index.js");

// A member-directed connector action synthesizes a "discord" channel list — the
// channel-category rejection fixture (a channel gates a transport, not a topic).
const discordDm = defineConnectorAction({
  connectorId: "discord",
  name: "dmMember",
  audience: { kind: "member", ref: (args: { userId: string }) => args.userId },
  run: async () => ({ ok: true }),
});

// ===========================================================================
// (1) BOOT validation — a journey `category` runs the SAME fail-closed guard as
//     a template `category`, plus the channel-category rejection on both.
// ===========================================================================

function bootJourney(category?: string) {
  return defineJourney({
    meta: {
      id: `cat-boot-${category ?? "none"}`,
      name: "Category boot fixture",
      enabled: true,
      trigger: { event: "cat.boot" },
      entryLimit: "unlimited",
      suppress: days(0),
      ...(category ? { category } : {}),
    },
    // The run never executes in a boot test.
    run: async () => {},
  });
}

// A one-entry template registry carrying `category` — cast past the augmented
// `TemplateRegistryMap` (the guard iterates `Object.entries` regardless).
function templatesWithCategory(category: string) {
  return {
    "test/gated": {
      component: () => null,
      defaultSubject: "Test subject",
      category,
    },
  } as unknown as typeof templates;
}

describe("createHogsendClient — journey category boot validation", () => {
  it("THROWS when a journey category is neither reserved nor a defined list", () => {
    let err: Error | undefined;
    try {
      createHogsendClient({
        journeys: [bootJourney("product-update")], // typo of "product-updates"
        lists: [productUpdates],
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err?.message).toContain("Journey");
    expect(err?.message).toContain('"product-update"');
    expect(err?.message).toContain("product-updates"); // the known list
    expect(err?.message).toContain("transactional"); // reserved built-ins
  });

  it("THROWS when a journey category names a CHANNEL preference list", () => {
    let err: Error | undefined;
    try {
      createHogsendClient({
        journeys: [bootJourney("discord")],
        connectorActions: [discordDm], // synthesizes the "discord" channel
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err?.message).toContain("Journey");
    expect(err?.message).toContain('"discord"');
    expect(err?.message).toContain(
      "channel preference list gates a delivery transport",
    );
  });

  it("THROWS when a TEMPLATE category names a CHANNEL preference list", () => {
    let err: Error | undefined;
    try {
      createHogsendClient({
        email: { templates: templatesWithCategory("discord") },
        connectorActions: [discordDm],
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err?.message).toContain('"test/gated"');
    expect(err?.message).toContain('"discord"');
    expect(err?.message).toContain(
      "channel preference list gates a delivery transport",
    );
  });

  it("THROWS for a journey category that is an OPT-IN list EXCLUDED via ENABLED_LISTS", () => {
    const optIn = defineList({
      id: "changelog",
      name: "Changelog",
      defaultOptIn: false,
    });
    let err: Error | undefined;
    try {
      createHogsendClient({
        journeys: [bootJourney("changelog")],
        lists: [optIn],
        enabledLists: "some-other-list",
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err?.message).toContain("Journey");
    expect(err?.message).toContain('"changelog"');
    expect(err?.message).toContain("OPT-IN");
    expect(err?.message).toContain("ENABLED_LISTS");
  });

  it("does NOT throw (WARNS) for a journey category that is an OPT-OUT list EXCLUDED via ENABLED_LISTS", async () => {
    const optOut = defineList({
      id: "newsletter",
      name: "Newsletter",
      defaultOptIn: true,
    });
    let client: ReturnType<typeof createHogsendClient> | undefined;
    expect(() => {
      client = createHogsendClient({
        journeys: [bootJourney("newsletter")],
        lists: [optOut],
        enabledLists: "some-other-list",
      });
    }).not.toThrow();
    expect(client).toBeDefined();
    await client?.dbClient.end({ timeout: 5 }).catch(() => {});
  });

  it("does NOT throw for a journey category matching a defined, ENABLED topic list", async () => {
    let client: ReturnType<typeof createHogsendClient> | undefined;
    expect(() => {
      client = createHogsendClient({
        journeys: [bootJourney("product-updates")],
        lists: [productUpdates],
      });
    }).not.toThrow();
    expect(client).toBeDefined();
    await client?.dbClient.end({ timeout: 5 }).catch(() => {});
  });
});

// ===========================================================================
// (2) SEND-TIME — the journey category reaches email_sends.category and gates
//     suppression through the same opt-in polarity.
// ===========================================================================

// `createHogsendClient` installs the list-registry + email-service singletons
// the send path reads. The boot tests above clobber both, so the send-time
// `beforeEach` restores them.
const container = createHogsendClient({
  email: { templates },
  lists: [productUpdates],
});
const { db } = container;

const providerSend = vi.fn(async (_opts: { to: string | string[] }) => ({
  id: "prov-msg-id",
}));
const fakeProvider: EmailProvider = {
  meta: { id: "resend", name: "counting-test" },
  capabilities: { nativeTracking: false },
  send: providerSend,
  sendBatch: vi.fn(async () => ({ results: [] })),
  verifyWebhook: vi.fn(() => {
    throw new Error("unused");
  }),
  parseWebhook: vi.fn(() => {
    throw new Error("unused");
  }),
};

function installMailer() {
  const mailer = createTrackedMailer(
    {
      defaultFrom: "Hogsend <noreply@hogsend.com>",
      // biome-ignore lint/suspicious/noExplicitAny: real container db threaded in
      db: db as any,
      templates,
    },
    { provider: fakeProvider },
  );
  // biome-ignore lint/suspicious/noExplicitAny: mailer satisfies EmailService
  setEmailService(mailer as any);
}

const createdUsers: string[] = [];
function newUser(): string {
  const id = randomUUID();
  createdUsers.push(id);
  return id;
}

// A journey that sends ONE email on entry, optionally stamping `meta.category`.
function makeJourney(opts: {
  journeyId: string;
  event: string;
  category?: string;
}) {
  return defineJourney({
    meta: {
      id: opts.journeyId,
      name: "Category send fixture",
      enabled: true,
      trigger: { event: opts.event },
      entryLimit: "unlimited",
      suppress: days(0),
      ...(opts.category ? { category: opts.category } : {}),
    },
    run: async (user) => {
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: "welcome",
        subject: "Category test",
        props: { name: "Ada" },
      });
    },
  });
}

function registerJourneys(
  ...journeys: Array<ReturnType<typeof defineJourney>>
): void {
  const registry = new JourneyRegistry();
  for (const j of journeys) registry.register(j.meta);
  setJourneyRegistry(registry);
}

function grabFn(): CapturedFn {
  const fn = mockFnHolder.fn;
  if (!fn) throw new Error("durable fn was not captured");
  return fn;
}

function input(userId: string) {
  return { userId, userEmail: `${userId}@example.com`, properties: {} };
}

// Base durable ctx: sleepFor/waitFor resolve instantly; a fixed workflowRunId.
function makeCtx(runId: string): Record<string, unknown> {
  return {
    workflowRunId: () => runId,
    sleepFor: async () => {},
    waitFor: async () => ({}),
    now: async () => new Date(),
  };
}

async function sendsFor(userId: string) {
  return db
    .select({
      status: emailSends.status,
      category: emailSends.category,
      toEmail: emailSends.toEmail,
    })
    .from(emailSends)
    .where(eq(emailSends.userId, userId));
}

beforeEach(() => {
  providerSend.mockClear();
  // Restore the singletons the boot-guard tests above clobbered: the list
  // registry (so `product-updates` is a known opt-in list at send time) and the
  // spy-provider tracked mailer.
  buildListRegistry([productUpdates], "*", synthesizeChannelLists([]));
  installMailer();
});

afterAll(async () => {
  if (createdUsers.length === 0) return;
  await db.delete(emailSends).where(inArray(emailSends.userId, createdUsers));
  await db
    .delete(journeyStates)
    .where(inArray(journeyStates.userId, createdUsers));
  await db.delete(userEvents).where(inArray(userEvents.userId, createdUsers));
  await db
    .delete(emailPreferences)
    .where(inArray(emailPreferences.userId, createdUsers));
  await db.delete(contacts).where(inArray(contacts.externalId, createdUsers));
});

describe("JourneyMeta.category — send-time behaviour", () => {
  it("a not-opted-in recipient of an opt-in journey category gets an unsubscribed/suppressed row stamped with the category", async () => {
    const userId = newUser();
    const journey = makeJourney({
      journeyId: `cat-send-notsub-${userId}`,
      event: `cat.notsub.${userId}`,
      category: "product-updates",
    });
    registerJourneys(journey);
    const fn = grabFn();

    // No email_preferences row → categories default to {} → an opt-in list
    // requires an explicit `true`, so the recipient is NOT subscribed.
    const r = (await fn(input(userId), makeCtx(`cat-notsub-${userId}`))) as {
      status: string;
    };
    expect(r.status).toBe("completed");

    // No provider call (suppressed by the category gate), but a failed row was
    // written stamped with the JOURNEY category (not the template's "journey").
    expect(providerSend).not.toHaveBeenCalled();
    const rows = await sendsFor(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("suppressed");
    expect(rows[0]?.category).toBe("product-updates");
  });

  it("an opted-in recipient sends, and email_sends.category is the journey category", async () => {
    const userId = newUser();
    const email = `${userId}@example.com`;
    // Explicit opt-in to product-updates.
    await db.insert(emailPreferences).values({
      userId,
      email,
      categories: { "product-updates": true },
      unsubscribedAll: false,
      suppressed: false,
    });

    const journey = makeJourney({
      journeyId: `cat-send-sub-${userId}`,
      event: `cat.sub.${userId}`,
      category: "product-updates",
    });
    registerJourneys(journey);
    const fn = grabFn();

    const r = (await fn(input(userId), makeCtx(`cat-sub-${userId}`))) as {
      status: string;
    };
    expect(r.status).toBe("completed");

    // The provider was called and the sent row carries the journey category —
    // NOT the "welcome" template's own "journey" category.
    expect(providerSend).toHaveBeenCalledTimes(1);
    const rows = await sendsFor(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("sent");
    expect(rows[0]?.category).toBe("product-updates");
  });

  it('a journey with NO category stamps the built-in "journey" category (regression)', async () => {
    const userId = newUser();
    const journey = makeJourney({
      journeyId: `cat-send-none-${userId}`,
      event: `cat.none.${userId}`,
      // No category — the boundary carries undefined, so the send falls back to
      // the hardcoded "journey" default.
    });
    registerJourneys(journey);
    const fn = grabFn();

    const r = (await fn(input(userId), makeCtx(`cat-none-${userId}`))) as {
      status: string;
    };
    expect(r.status).toBe("completed");

    // "journey" is a reserved built-in (unknown to the list registry → opt-in
    // default `?? true` → subscribed), so the send goes out, stamped "journey".
    expect(providerSend).toHaveBeenCalledTimes(1);
    const rows = await sendsFor(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("sent");
    expect(rows[0]?.category).toBe("journey");
  });
});
