import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The demo journeys call `sendFeedItem`, which reads its OWN db singleton off
// `DATABASE_URL`. Point it at the real 5434 test DB (mirrors feed-backend.test)
// BEFORE importing the engine so the singleton hits the same database.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Hatchet is module-mocked — the demo run functions never reach a live engine.
vi.mock("../lib/hatchet.js", () => ({
  hatchet: {
    durableTask: vi.fn(() => ({
      run: vi.fn(),
      runNoWait: vi.fn(),
      runAndWait: vi.fn(),
    })),
    task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
    events: { push: vi.fn() },
    runs: { cancel: vi.fn(), get: vi.fn() },
    worker: vi.fn(),
  },
}));

const { contacts, feedItems } = await import("@hogsend/db");
const { eq, sql } = await import("drizzle-orm");
const { createHogsendClient } = await import("@hogsend/engine");
const { runDemoLaunch, runDemoTrialNudge, runDemoWelcome } = await import(
  "../journeys/demo-inapp.js"
);
const { demoLaunch, demoTrialNudge, demoWelcome } = await import(
  "../journeys/index.js"
);
const { DemoEvents } = await import("../journeys/constants/index.js");

import type { JourneyContext, JourneyUser } from "@hogsend/core/types";

const container = createHogsendClient();
const { db } = container;

// An anonymous demo visitor — the canonical key IS the raw anon id (no contact
// row exists yet), exactly like a real docs visitor firing `demo.*`.
const ANON_A = "demo-anon-visitor-a";
const ANON_B = "demo-anon-visitor-b";
const ANON_C = "demo-anon-visitor-c";

/** Build a fixture firing user (mirrors what the ingest pipeline hands `run`). */
function makeUser(anonId: string, name?: string): JourneyUser {
  return {
    id: anonId,
    email: "",
    properties: name ? { name } : {},
    stateId: "00000000-0000-0000-0000-000000000000",
    journeyId: "demo",
    journeyName: "Demo",
  };
}

/** Minimal ctx — `runDemoWelcome` only touches `history.hasEvent`. */
function makeCtx(found: boolean): JourneyContext {
  return {
    history: {
      hasEvent: async () => ({ found, count: found ? 1 : 0 }),
    },
  } as unknown as JourneyContext;
}

async function ensureFeedItemsTable() {
  // The feed migration (0034) may not be applied on the test DB; apply only the
  // feed_items DDL idempotently so the suite is self-contained (copied from
  // feed-backend.test.ts).
  await db.execute(sql`
    DO $$ BEGIN
      CREATE TYPE "public"."feed_item_status" AS ENUM('unseen', 'seen', 'read', 'archived');
    EXCEPTION WHEN duplicate_object THEN null; END $$;
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "feed_items" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "recipient_key" text NOT NULL,
      "contact_id" uuid,
      "type" text NOT NULL,
      "title" text,
      "body" text,
      "blocks" jsonb,
      "action_url" text,
      "metadata" jsonb,
      "journey_state_id" uuid,
      "template_key" text,
      "category" text DEFAULT 'in_app' NOT NULL,
      "status" "feed_item_status" DEFAULT 'unseen' NOT NULL,
      "seen_at" timestamp with time zone,
      "read_at" timestamp with time zone,
      "archived_at" timestamp with time zone,
      "idempotency_key" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS "feed_items_idempotency_key_idx" ON "feed_items" USING btree ("idempotency_key");`,
  );
}

async function cleanup() {
  for (const key of [ANON_A, ANON_B, ANON_C]) {
    await db.delete(feedItems).where(eq(feedItems.recipientKey, key));
    // sendFeedItem mints an external_id = anon-id contact for the anon recipient.
    await db.delete(contacts).where(eq(contacts.externalId, key));
    await db.delete(contacts).where(eq(contacts.anonymousId, key));
  }
}

beforeAll(async () => {
  await ensureFeedItemsTable();
  await cleanup();
});

afterAll(cleanup);

// ===========================================================================
// The journeys are registered with the trigger events the browser captures.
// ===========================================================================
describe("demo journey registration", () => {
  it("each demo journey triggers on its demo.* event", () => {
    expect(demoWelcome.meta.trigger.event).toBe(DemoEvents.WELCOME);
    expect(demoLaunch.meta.trigger.event).toBe(DemoEvents.LAUNCH_ANNOUNCEMENT);
    expect(demoTrialNudge.meta.trigger.event).toBe(DemoEvents.TRIAL_ENDING);
    // Unlimited re-entry so the demo can be clicked repeatedly.
    expect(demoWelcome.meta.entryLimit).toBe("unlimited");
  });
});

// ===========================================================================
// demo.welcome → a personalized feed_items row for the firing anon visitor.
// ===========================================================================
describe("runDemoWelcome", () => {
  it("inserts a personalized welcome item for the anon recipient", async () => {
    await runDemoWelcome(makeUser(ANON_A, "Doug"), makeCtx(false));

    const rows = await db
      .select()
      .from(feedItems)
      .where(eq(feedItems.recipientKey, ANON_A));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.type).toBe("welcome");
    expect(row?.title).toBe("Welcome, Doug 👋");
    expect(row?.actionUrl).toBe("https://hogsend.com/docs/client-side/try");
    expect(row?.status).toBe("unseen");
    expect(row?.category).toBe("in_app");
  });

  it("falls back to 'there' when no name property is present", async () => {
    await runDemoWelcome(makeUser(ANON_B), makeCtx(false));

    const rows = await db
      .select()
      .from(feedItems)
      .where(eq(feedItems.recipientKey, ANON_B));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Welcome, there 👋");
  });

  it("titles 'Welcome back' on a returning visitor (history.found)", async () => {
    await runDemoWelcome(makeUser(ANON_C, "Ada"), makeCtx(true));

    const rows = await db
      .select()
      .from(feedItems)
      .where(eq(feedItems.recipientKey, ANON_C));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Welcome back, Ada 👋");
  });
});

// ===========================================================================
// demo.launch_announcement / demo.trial_ending → trackable items with links.
// ===========================================================================
describe("runDemoLaunch + runDemoTrialNudge", () => {
  it("launch inserts a broadcast item with an actionUrl", async () => {
    await runDemoLaunch(makeUser(ANON_A, "Doug"));

    const rows = await db
      .select()
      .from(feedItems)
      .where(eq(feedItems.recipientKey, ANON_A));
    const launch = rows.find((r) => r.type === "announcement");
    expect(launch).toBeTruthy();
    expect(launch?.title).toBe("Doug — Hogsend v1 is live 🚀");
    expect(launch?.actionUrl).toBe("https://hogsend.com/docs");
  });

  it("trial nudge inserts a lifecycle item with a trackable CTA", async () => {
    await runDemoTrialNudge(makeUser(ANON_B));

    const rows = await db
      .select()
      .from(feedItems)
      .where(eq(feedItems.recipientKey, ANON_B));
    const nudge = rows.find((r) => r.type === "nudge");
    expect(nudge).toBeTruthy();
    expect(nudge?.title).toBe("Your trial ends in 3 days");
    expect(nudge?.actionUrl).toBe("https://hogsend.com/pricing");
  });
});
