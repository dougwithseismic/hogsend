// @vitest-environment happy-dom

// ─────────────────────────────────────────────────────────────────────────────
// DEFERRED (test-infra rabbit hole, flagged in the Phase 4 brief).
//
// This suite renders the REAL <HogsendProvider><NotificationBell/></> against
// the in-process engine and asserts the bell badges the live unseen_count after
// a server `sendFeedItem` + the hook's mount fetch. The React wiring itself is
// proven sound here: with the `fetch` prop forwarded by HogsendProvider and the
// react/react-dom dedupe in vitest.config, hooks render and the SDK uses the
// injected `browserFetch`.
//
// The ONLY blocker is a happy-dom networking quirk, NOT a product bug:
//   • The engine's publishable-key gate is Origin-allowlisted (fail-closed).
//   • The browser sets `Origin`; JS cannot — our `browserFetch` injects it so
//     `app.request` (Hono) carries it. This works perfectly under the `node`
//     test env (see feed-client-integration.test.ts, all green).
//   • Under happy-dom, the GLOBAL `Request`/`Headers` are spec-compliant and
//     enforce the FORBIDDEN-HEADER list, which includes `Origin` — so Hono's
//     internal `new Request(url, { headers })` SILENTLY DROPS our injected
//     Origin, and every publishable request 403s ("origin not allowed").
//   • Verified directly: under happy-dom `new Request(url,{headers:{Origin}})`
//     yields `headers.get("origin") === null`; under node it is preserved.
//
// Clean fix paths for the follow-up (pick one):
//   (a) Run the network leg with node's lenient WHATWG `Request`/`Headers`
//       (recover the originals happy-dom overwrote, or swap a lenient global
//       `Request` for `app.request` only), keeping happy-dom for rendering.
//   (b) Drive the feed fetch outside happy-dom (node fetch into `app.request`)
//       and only mount the bell against a pre-seeded store.
//   (c) Add a tiny engine test-affordance to read Origin from a non-forbidden
//       header — but that touches the gate, so NOT done here.
//
// The @hogsend/js feed integration test (feed-client-integration.test.ts) +
// check-types stand as the closed-loop proof per the brief. Un-skip once (a)
// or (b) lands. The full provider/bell/fetch wiring below is intact so the
// follow-up is a one-seam change.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, createHmac } from "node:crypto";
import { HogsendProvider, NotificationBell } from "@hogsend/react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Same DB-singleton pinning as the JS feed integration test: `sendFeedItem` and
// the route container must hit the same 5434 test DB.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

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

// The engine's `env.ts` (via @t3-oss/env-core) treats `typeof window !==
// "undefined"` as a CLIENT and blocks server-only env access (HATCHET_*, etc.).
// happy-dom installs a `window` at environment setup, so importing the engine
// under happy-dom trips that guard. Stash + remove the DOM globals across the
// engine/db import (server env reads happen at module-eval), then restore the
// SAME happy-dom DOM so @testing-library can still render. This is a
// test-harness shim ONLY — no engine behavior changes.
const __dom = {
  window: (globalThis as Record<string, unknown>).window,
  document: (globalThis as Record<string, unknown>).document,
  navigator: (globalThis as Record<string, unknown>).navigator,
  self: (globalThis as Record<string, unknown>).self,
};
for (const k of ["window", "document", "self"]) {
  delete (globalThis as Record<string, unknown>)[k];
}

const { apiKeys, contacts, feedItems, userEvents } = await import(
  "@hogsend/db"
);
const { eq } = await import("drizzle-orm");
const { createApp, createHogsendClient, sendFeedItem } = await import(
  "@hogsend/engine"
);

// Restore the happy-dom DOM for the React render.
for (const [k, v] of Object.entries(__dom)) {
  if (v !== undefined) (globalThis as Record<string, unknown>)[k] = v;
}

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
} as unknown as ReturnType<typeof createHogsendClient>["hatchet"];

// Built lazily inside the (skipped) suite so a DEFERRED file does ZERO engine /
// DB / network work at import — un-skipping calls `setup()` in `beforeAll`.
let app: ReturnType<typeof createApp>;
let db: ReturnType<typeof createHogsendClient>["db"];
function setup(): void {
  const container = createHogsendClient({
    overrides: { hatchet: mockHatchet },
  });
  app = createApp(container);
  db = container.db;
}

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

const AUTH_SECRET = "test-secret-for-vitest-minimum-32-characters-long";
function mintUserToken(userId: string): string {
  const payload = { userId, exp: Math.floor(Date.now() / 1000) + 3600 };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", AUTH_SECRET)
    .update(body)
    .digest("base64url");
  return `${body}.${sig}`;
}

const ORIGIN = "https://feed-react.example.com";
const PK_OK = "pk_feed_react_bell_allowed_origin_key";
const API_BASE = "https://feed-react-engine.test";
const R_USER = "feed-react-recipient";
const R_EMAIL = "feed-react-recipient@example.com";

/**
 * Browser-faithful fetch: route into the in-process app + inject Origin. Under
 * happy-dom the global `Headers`/`Request` classes are the DOM ones, which Hono
 * doesn't accept — so flatten the SDK's headers into a PLAIN object (parsed
 * and hand `app.request` a plain init it builds its own (undici) Request from.
 */
function browserFetch(origin: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const flat: Record<string, string> = { Origin: origin };
    const h = init?.headers;
    if (h) {
      if (typeof (h as Headers).forEach === "function") {
        (h as Headers).forEach((value, key) => {
          flat[key] = value;
        });
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) flat[k] = v;
      } else {
        Object.assign(flat, h as Record<string, string>);
      }
    }
    return app.request(url, { ...init, headers: flat });
  }) as typeof fetch;
}

async function ensureFeedItemsTable() {
  await db.execute(`
    DO $$ BEGIN
      CREATE TYPE "public"."feed_item_status" AS ENUM('unseen', 'seen', 'read', 'archived');
    EXCEPTION WHEN duplicate_object THEN null; END $$;
  `);
  await db.execute(`
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
    `CREATE UNIQUE INDEX IF NOT EXISTS "feed_items_idempotency_key_idx" ON "feed_items" USING btree ("idempotency_key");`,
  );
}

async function cleanupDb() {
  await db.delete(feedItems).where(eq(feedItems.recipientKey, R_USER));
  await db.delete(userEvents).where(eq(userEvents.userId, R_USER));
  await db.delete(contacts).where(eq(contacts.externalId, R_USER));
}

let pkId = "";

// SKIPPED: happy-dom strips the injected `Origin` header (forbidden-header
// enforcement) → publishable gate 403s. See the file-top note for the fix path.
describe.skip("@hogsend/react <NotificationBell> renders the live unseen count", () => {
  beforeAll(async () => {
    setup();
    await ensureFeedItemsTable();
    await cleanupDb();
    const [k] = await db
      .insert(apiKeys)
      .values({
        name: "feed react bell publishable",
        keyPrefix: PK_OK.slice(0, 8),
        keyHash: hashKey(PK_OK),
        scopes: ["ingest-public"],
        allowedOrigins: [ORIGIN],
      })
      .returning({ id: apiKeys.id });
    pkId = k?.id ?? "";
    await db.insert(contacts).values({ externalId: R_USER, email: R_EMAIL });
  });

  afterEach(() => {
    cleanup(); // unmount React trees → provider teardown closes the poll channel
  });

  afterAll(async () => {
    await cleanupDb();
    if (pkId) await db.delete(apiKeys).where(eq(apiKeys.id, pkId));
  });

  it("shows the unseen badge after a server sendFeedItem + mount fetch", async () => {
    // Seed THREE unseen items for the recipient BEFORE render.
    for (let i = 0; i < 3; i++) {
      const sent = await sendFeedItem({
        recipient: { userId: R_USER },
        type: "welcome",
        title: `Notification ${i}`,
        idempotencyKey: `feed-react-bell-${i}`,
      });
      expect(sent.feedItemId).toBeTruthy();
    }

    // Render the real provider + bell. The bell's `useHogsendFeed` auto-fetches
    // on mount through the injected browserFetch, populating the store slice the
    // badge reads. `badgeCountType="unseen"` badges metadata.unseen_count.
    render(
      <HogsendProvider
        apiUrl={API_BASE}
        publishableKey={PK_OK}
        userId={R_USER}
        userToken={mintUserToken(R_USER)}
        fetch={browserFetch(ORIGIN)}
      >
        <NotificationBell badgeCountType="unseen" />
      </HogsendProvider>,
    );

    // Before fetch resolves the bell renders with 0 (no badge). After the mount
    // fetch lands, the store's unseen_count → 3 flows through the selector and
    // the badge appears with "3".
    const bell = await screen.findByRole("button", { name: /notifications/i });
    expect(bell).toBeTruthy();

    await waitFor(() => {
      const badge = bell.querySelector("[data-hs-badge]");
      expect(badge).not.toBeNull();
      expect(badge?.textContent).toBe("3");
    });

    // The bell's data-state attrs reflect the unseen badge too.
    expect(bell.getAttribute("data-unseen")).toBe("true");
    expect(bell.getAttribute("data-has-badge")).toBe("true");
  });
});
