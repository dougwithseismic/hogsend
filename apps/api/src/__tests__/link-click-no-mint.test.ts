/**
 * R1 — the link-click bus re-ingest must INHERIT the observation refusal.
 *
 * #621 stopped three observation paths from minting a `contacts` row and set
 * THE LAW (D11): a refusal is inherited by every re-ingest DERIVED from a
 * refused event. A pin-less re-resolve mints `external_id = <anonId>`, which is
 * strictly WORSE than the ghost it replaces — that row then answers
 * `collidesWithIdentified` (`lib/contacts.ts:55`) and 403-locks the visitor out
 * of their OWN feed (`routes/feed/recipient.ts:115`).
 *
 * `pushLinkClickEvent` (`lib/tracking-events.ts`) was missed. It re-ingests
 * `{ userId: <the link's distinctId> }`, and `mintLink` copies whatever
 * `distinctId` the caller passes for a `personal` link (`lib/links.ts` —
 * `type === "personal" ? (opts.distinctId ?? null) : null`), so a journey that
 * mints a link for an anonymous visitor produces an anon-keyed personal link.
 * Clicking it used to mint the pathological row.
 *
 * What must NOT regress: the refusal costs no observation. The click still
 * 302s, and the `link.clicked` event still stores under the same key — only the
 * `contacts` row is skipped. Both are asserted below, because a "fix" that
 * dropped the event would pass a contacts-only assertion while silently
 * breaking every journey that triggers on a link click.
 */
import type { HogsendClient } from "@hogsend/engine";
import { afterAll, expect, it, vi } from "vitest";

// DB-touching test. The DEFAULT below is the repo-wide one every file in this
// directory shares, and it is what CI's service container listens on
// (.github/workflows/ci.yml). Point a worktree at its own stack by exporting
// HOGSEND_TEST_DATABASE_URL — never by editing the default.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, linkClicks, links, trackedLinks, userEvents } = await import(
  "@hogsend/db"
);
const { and, eq } = await import("drizzle-orm");
const { createApp, createHogsendClient, mintLink } = await import(
  "@hogsend/engine"
);

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

const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const app = createApp(container);
const { db } = container;

// A browser-shaped anon id that NO contact owns — the exact state #621 makes
// the steady state (observation no longer mints, so the key is unowned).
const RUN = `lcm-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ANON_KEY = `${RUN}-anon`;

const mintedLinkIds: string[] = [];

afterAll(async () => {
  for (const id of mintedLinkIds) {
    const tracked = await db
      .select({ id: trackedLinks.id })
      .from(trackedLinks)
      .where(eq(trackedLinks.linkId, id));
    for (const t of tracked) {
      await db.delete(linkClicks).where(eq(linkClicks.trackedLinkId, t.id));
    }
    await db.delete(trackedLinks).where(eq(trackedLinks.linkId, id));
    await db.delete(links).where(eq(links.id, id));
  }
  await db.delete(userEvents).where(eq(userEvents.userId, ANON_KEY));
  // Swept regardless of the assertions so a RED run never leaves a ghost
  // behind to poison the next one.
  await db.delete(contacts).where(eq(contacts.externalId, ANON_KEY));
  await db.delete(contacts).where(eq(contacts.anonymousId, ANON_KEY));
});

it("a click on an anon-keyed personal link stores the event but mints NO contact", async () => {
  const minted = await mintLink({
    db,
    baseUrl: "http://localhost:3002",
    url: "https://example.com/r1-link-click",
    type: "personal",
    // The whole point: a personal link minted for a visitor who was never
    // identified, so this key owns no `contacts` row.
    distinctId: ANON_KEY,
    source: "test",
  });
  mintedLinkIds.push(minted.linkId);

  // A browser-shaped UA — `isBotOrPrefetch` suppresses the re-ingest entirely
  // for an unfurl bot, which would make this test pass for the wrong reason.
  const res = await app.request(`/v1/t/c/${minted.trackedLinkId}`, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
    redirect: "manual",
  });

  // The redirect is returned unconditionally — the re-ingest is fire-and-forget
  // (`void … .catch(logger.warn)`), so refusing the mint must not touch it.
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("https://example.com/r1-link-click");

  // NOTHING IS LOST. The derived event still stores under the same key. This is
  // the assertion that separates "inherit the refusal" from "drop the event".
  const stored = await vi.waitFor(
    async () => {
      const rows = await db
        .select({ id: userEvents.id })
        .from(userEvents)
        .where(
          and(
            eq(userEvents.userId, ANON_KEY),
            eq(userEvents.event, "link.clicked"),
          ),
        );
      expect(rows).toHaveLength(1);
      return rows;
    },
    { timeout: 5000, interval: 50 },
  );
  expect(stored).toHaveLength(1);

  // THE FIX. The re-ingest must not resolve-and-create. Both columns are
  // checked because the create arm writes the key into `external_id` (the
  // pathological shape), and a future change could plausibly route it to
  // `anonymous_id` instead — neither is acceptable.
  const byExternalId = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.externalId, ANON_KEY));
  expect(byExternalId).toHaveLength(0);

  const byAnonymousId = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.anonymousId, ANON_KEY));
  expect(byAnonymousId).toHaveLength(0);
});
