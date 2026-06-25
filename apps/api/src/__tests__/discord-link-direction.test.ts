import type { AnalyticsProvider, HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Hatchet via the override seam — the merge runs inside `resolveOrCreateContact`
// (driven through a direct `ingestEvent`); the downstream push lands on a spy.
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

const { contactAliases, contacts, userEvents } = await import("@hogsend/db");
const { eq, inArray } = await import("drizzle-orm");
const { createHogsendClient, ingestEvent } = await import("@hogsend/engine");

// ---------------------------------------------------------------------------
// Spy analytics provider — `mergeIdentities` + `capture` are `vi.fn()`. Injected
// via the BARE `analytics: spyProvider` arm (register-and-ACTIVATE). The vitest
// env sets no POSTHOG_API_KEY / ANALYTICS_PROVIDER, so no real PostHog provider
// wins resolution over this spy. `identityMerge: true` so the engine's helper
// fans `mergeIdentities` out instead of no-oping.
// ---------------------------------------------------------------------------
const mergeIdentities = vi.fn();
const spyProvider: AnalyticsProvider = {
  meta: { id: "spy", name: "Spy" },
  capabilities: {
    personReads: false,
    personWrites: true,
    identityMerge: true,
  },
  getPersonProperties: vi.fn(async () => ({})),
  setPersonProperties: vi.fn(async () => {}),
  mergeIdentities,
  capture: vi.fn(),
};

const container = createHogsendClient({
  analytics: spyProvider,
  overrides: { hatchet: mockHatchet },
});
// Guard — the spy IS the resolved active provider.
if (container.analytics !== spyProvider) {
  throw new Error(
    "spy analytics provider is not the active container provider",
  );
}
const { db } = container;

const RUN = `dld-${Date.now()}`;

// Identity keys for the two contacts being collided at /link.
const SNOWFLAKE = `${RUN}-snowflake`;
const WEB_USER = `${RUN}-web-user`;
const EMAIL = `${RUN}-web@example.com`;

// Contact ids + event keys to clean up.
const contactIdsToDelete: string[] = [];
const eventKeysToDelete: string[] = [];

afterAll(async () => {
  if (eventKeysToDelete.length > 0) {
    await db
      .delete(userEvents)
      .where(inArray(userEvents.userId, eventKeysToDelete));
  }
  if (contactIdsToDelete.length > 0) {
    await db
      .delete(contactAliases)
      .where(inArray(contactAliases.contactId, contactIdsToDelete));
    await db.delete(contacts).where(inArray(contacts.id, contactIdsToDelete));
  }
  await container.dbClient.end({ timeout: 5 }).catch(() => {});
});

// ===========================================================================
// /link identity direction. An anonymous discord-only contact (no external_id →
// canonical key = its uuid) collides with the identified email/web contact (has
// external_id = WEB_USER) when `/link` resolves BOTH discordId + email. The
// SURVIVOR RULE ranks externalId-identified ABOVE anonymous, so the web contact
// wins survivor and the discord uuid is the absorbed (safe, anon/uuid) alias.
// discordId folds onto the survivor; the analytics merge direction (MF-1) is
// survivor=distinctId, absorbed=alias.
// ===========================================================================
describe("discord /link identity direction", () => {
  it("anonymous discord contact loses survivor to the identified email/web contact at /link; discordId folds onto the survivor; alias direction is correct", async () => {
    // Anonymous discord-only contact (NO externalId). Its canonical key is its
    // contact uuid → a SAFE absorbable key (mergedKeys).
    const [discordRow] = await db
      .insert(contacts)
      .values({
        discordId: SNOWFLAKE,
        properties: { discord: { id: SNOWFLAKE } },
      })
      .returning();
    if (!discordRow) throw new Error("failed to insert discord contact");
    contactIdsToDelete.push(discordRow.id);
    eventKeysToDelete.push(discordRow.id);

    // Discord-keyed history under the contact uuid — must follow onto the
    // survivor after the merge.
    await db.insert(userEvents).values({
      userId: discordRow.id,
      event: "discord.message_sent",
      properties: {},
    });

    // Identified email/web contact (has external_id) — wins the SURVIVOR RULE.
    const [webRow] = await db
      .insert(contacts)
      .values({ externalId: WEB_USER, email: EMAIL })
      .returning();
    if (!webRow) throw new Error("failed to insert web contact");
    contactIdsToDelete.push(webRow.id);
    eventKeysToDelete.push(WEB_USER);

    // Drive the /link collide-merge: an event naming BOTH the discordId and the
    // email resolves both rows → collide-merge inside resolveOrCreateContact.
    const res = await ingestEvent({
      db,
      registry: container.registry,
      hatchet: container.hatchet,
      logger: container.logger,
      analytics: spyProvider,
      event: {
        event: "discord.linked",
        discordId: SNOWFLAKE,
        userEmail: EMAIL,
        eventProperties: {},
      },
    });
    expect(res.stored).toBe(true);

    // Direction (MF-1): survivor = the identified web key (distinctId), the
    // absorbed discord uuid = alias.
    expect(mergeIdentities).toHaveBeenCalledWith({
      distinctId: WEB_USER,
      alias: discordRow.id,
    });
    // The survivor's identified key is NEVER absorbed as an alias.
    expect(mergeIdentities).not.toHaveBeenCalledWith(
      expect.objectContaining({ alias: WEB_USER }),
    );
    // The discord snowflake is NOT a canonical text key, so it is never aliased.
    expect(mergeIdentities).not.toHaveBeenCalledWith(
      expect.objectContaining({ alias: SNOWFLAKE }),
    );

    // The anonymous discord contact is soft-deleted (the loser).
    const [loserRow] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, discordRow.id));
    expect(loserRow?.deletedAt).not.toBeNull();

    // discordId folded onto the survivor (the identified web contact).
    const [survivorRow] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, webRow.id));
    expect(survivorRow?.discordId).toBe(SNOWFLAKE);
  });
});
