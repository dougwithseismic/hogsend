import type { HogsendClient } from "@hogsend/engine";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Hatchet via the override seam — every send here runs OUTSIDE a journey
// boundary (getJourneyBoundary() is undefined), so `sendConnectorAction` takes
// the no-boundary path: gate → run the action directly, no ledger. The mock
// keeps `createHogsendClient` from reaching a live engine at boot.
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

const { contacts, emailPreferences, connectorDeliveries } = await import(
  "@hogsend/db"
);
const { eq, inArray } = await import("drizzle-orm");
const {
  buildListRegistry,
  createHogsendClient,
  defineConnectorAction,
  isConnectorActionSkipped,
  resetListRegistry,
  sendConnectorAction,
  synthesizeChannelLists,
} = await import("@hogsend/engine");

// --- Fake connector actions, all on connector id "fakeconn" ---
// A member-directed action whose audience extractor echoes `args.refs`, so each
// test drives which candidate refs the gate resolves. `run` records its
// invocation via `runSpy` — the load-bearing "did we actually send?" signal.
const runSpy = vi.fn();
const memberAction = defineConnectorAction<{ refs: string[] }, unknown>({
  connectorId: "fakeconn",
  name: "dm",
  audience: { kind: "member", ref: (args) => args.refs },
  run: async (args, ctx) => {
    runSpy(args, ctx);
    return { messageId: "m1", delivered: true };
  },
});

// A member action whose extractor THROWS — must fail OPEN (send proceeds).
const throwSpy = vi.fn();
const throwingAction = defineConnectorAction<{ x: string }, unknown>({
  connectorId: "fakeconn",
  name: "dmThrow",
  audience: {
    kind: "member",
    ref: () => {
      throw new Error("boom");
    },
  },
  run: async (args, ctx) => {
    throwSpy(args, ctx);
    return { messageId: "m2", delivered: true };
  },
});

// An OPS/channel-directed action (no audience) — never gated.
const opsSpy = vi.fn();
const opsAction = defineConnectorAction<{ channel: string }, unknown>({
  connectorId: "fakeconn",
  name: "broadcast",
  run: async (args, ctx) => {
    opsSpy(args, ctx);
    return { messageId: "m3", delivered: true };
  },
});

const container = createHogsendClient({
  connectorActions: [memberAction, throwingAction, opsAction],
  overrides: { hatchet: mockHatchet },
});
const { db } = container;

// Register the channel lists so `isSubscribed` resolves the "fakeconn" channel
// (opt-out polarity: blocked only on explicit `false`). `buildListRegistry`
// installs the process singleton `checkActionAudience` reads.
buildListRegistry([], undefined, synthesizeChannelLists([memberAction]));

const RUN = `cap-${Date.now()}`;
const createdContactIds: string[] = [];
const createdPrefIds: string[] = [];

async function seedContact(
  values: Partial<typeof contacts.$inferInsert>,
): Promise<typeof contacts.$inferSelect> {
  const [row] = await db.insert(contacts).values(values).returning();
  if (!row) throw new Error("seedContact: insert returned no row");
  createdContactIds.push(row.id);
  return row;
}

async function seedPref(
  values: typeof emailPreferences.$inferInsert,
): Promise<void> {
  const [row] = await db
    .insert(emailPreferences)
    .values(values)
    .returning({ id: emailPreferences.id });
  if (row) createdPrefIds.push(row.id);
}

/** Assert no `connector_deliveries` row was ever claimed for the fake connector. */
async function fakeconnDeliveryCount(): Promise<number> {
  const rows = await db
    .select({ id: connectorDeliveries.id })
    .from(connectorDeliveries)
    .where(eq(connectorDeliveries.connectorId, "fakeconn"));
  return rows.length;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  if (createdPrefIds.length > 0) {
    await db
      .delete(emailPreferences)
      .where(inArray(emailPreferences.id, createdPrefIds));
  }
  if (createdContactIds.length > 0) {
    await db.delete(contacts).where(inArray(contacts.id, createdContactIds));
  }
  resetListRegistry();
  await container.dbClient.end({ timeout: 5 }).catch(() => {});
});

describe("sendConnectorAction — member-directed preference gating", () => {
  it("skips channel_unsubscribed when the recipient opted out of the channel", async () => {
    const email = `${RUN}-blocked@example.com`;
    const externalId = `${RUN}-blocked`;
    await seedContact({ email, externalId });
    await seedPref({
      userId: externalId,
      email,
      categories: { fakeconn: false },
    });

    const result = await sendConnectorAction({
      connectorId: "fakeconn",
      action: "dm",
      args: { refs: [email] },
    });

    expect(isConnectorActionSkipped(result)).toBe(true);
    expect(result).toMatchObject({
      skipped: true,
      reason: "channel_unsubscribed",
      connectorId: "fakeconn",
      action: "dm",
    });
    // The action NEVER ran, and no ledger row was claimed (skip precedes the
    // connector_deliveries insert — this is also the outside-boundary proof).
    expect(runSpy).not.toHaveBeenCalled();
    expect(await fakeconnDeliveryCount()).toBe(0);
  });

  it("skips unsubscribed_all when the recipient unsubscribed globally", async () => {
    const email = `${RUN}-allout@example.com`;
    const externalId = `${RUN}-allout`;
    await seedContact({ email, externalId });
    await seedPref({ userId: externalId, email, unsubscribedAll: true });

    const result = await sendConnectorAction({
      connectorId: "fakeconn",
      action: "dm",
      args: { refs: [email] },
    });

    expect(isConnectorActionSkipped(result)).toBe(true);
    expect(result).toMatchObject({ reason: "unsubscribed_all" });
    expect(runSpy).not.toHaveBeenCalled();
    expect(await fakeconnDeliveryCount()).toBe(0);
  });

  it("delivers when the recipient has no explicit category (opt-out default)", async () => {
    const email = `${RUN}-clean@example.com`;
    const externalId = `${RUN}-clean`;
    await seedContact({ email, externalId });
    // No email_preferences row at all → clean default → subscribed.

    const result = await sendConnectorAction({
      connectorId: "fakeconn",
      action: "dm",
      args: { refs: [email] },
    });

    expect(isConnectorActionSkipped(result)).toBe(false);
    expect(result).toMatchObject({ messageId: "m1", delivered: true });
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it("delivers when the ref resolves NO contact (no preference surface)", async () => {
    const result = await sendConnectorAction({
      connectorId: "fakeconn",
      action: "dm",
      args: { refs: [`${RUN}-nobody@example.com`] },
    });

    expect(isConnectorActionSkipped(result)).toBe(false);
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it("aggregates across rows: an (email,email) opt-out beats a clean (extId,email) row", async () => {
    const email = `${RUN}-multi@example.com`;
    const externalId = `${RUN}-multi`;
    await seedContact({ email, externalId });
    // Imported suppression keyed (email, email) with the master opt-out...
    await seedPref({ userId: email, email, unsubscribedAll: true });
    // ...and a newer clean interactive row keyed (external_id, email).
    await seedPref({ userId: externalId, email, unsubscribedAll: false });

    const result = await sendConnectorAction({
      connectorId: "fakeconn",
      action: "dm",
      args: { refs: [email] },
    });

    expect(isConnectorActionSkipped(result)).toBe(true);
    expect(result).toMatchObject({ reason: "unsubscribed_all" });
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("never gates an ops action (no audience), even for an unsubscribed recipient", async () => {
    const email = `${RUN}-opsout@example.com`;
    const externalId = `${RUN}-opsout`;
    await seedContact({ email, externalId });
    await seedPref({ userId: externalId, email, unsubscribedAll: true });

    const result = await sendConnectorAction({
      connectorId: "fakeconn",
      action: "broadcast",
      args: { channel: email },
    });

    expect(isConnectorActionSkipped(result)).toBe(false);
    expect(result).toMatchObject({ messageId: "m3", delivered: true });
    expect(opsSpy).toHaveBeenCalledTimes(1);
  });

  it("resolves a telegram-style namespaced contact and gates it", async () => {
    const rawId = `${RUN}-12345`;
    const externalId = `telegram:${rawId}`;
    const email = `${RUN}-tg@example.com`;
    // A linked telegram contact keyed externalId "telegram:<chatId>".
    await seedContact({ email, externalId });
    await seedPref({
      userId: externalId,
      email,
      categories: { fakeconn: false },
    });

    // First candidate (raw id) resolves nothing; the namespaced one resolves.
    const result = await sendConnectorAction({
      connectorId: "fakeconn",
      action: "dm",
      args: { refs: [rawId, externalId] },
    });

    expect(isConnectorActionSkipped(result)).toBe(true);
    expect(result).toMatchObject({ reason: "channel_unsubscribed" });
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("fails OPEN (delivers) when the audience extractor throws", async () => {
    const result = await sendConnectorAction({
      connectorId: "fakeconn",
      action: "dmThrow",
      args: { x: "anything" },
    });

    expect(isConnectorActionSkipped(result)).toBe(false);
    expect(result).toMatchObject({ messageId: "m2", delivered: true });
    expect(throwSpy).toHaveBeenCalledTimes(1);
  });
});

// The PRIMARY "reach an existing app user on a chat platform" case: a platform
// links onto an ALREADY-identified contact, so external_id stays the app id and
// the chat id lives ONLY under `properties.<ns>` (the DEEP_MERGE_KEYS
// convention). A namespaced ref must resolve THAT contact via the properties
// legs, else an opted-out identified user gets DM'd anyway.
describe("sendConnectorAction — namespaced properties resolution", () => {
  it("resolves a link-onto-identified contact via properties.<ns>.chat_id and gates it", async () => {
    const chatId = `${RUN}-555`;
    const appExtId = `${RUN}-app-ext`;
    const email = `${RUN}-idlink@example.com`;
    // external_id is the APP id; the chat id lives only in properties.tgfake.
    await seedContact({
      email,
      externalId: appExtId,
      properties: { tgfake: { chat_id: chatId, id: chatId } },
    });
    // Preference surface is keyed to the identity (external_id), category off.
    await seedPref({
      userId: appExtId,
      email,
      categories: { fakeconn: false },
    });

    // The caller only has the chat id — a namespaced ref, no app id / email.
    const result = await sendConnectorAction({
      connectorId: "fakeconn",
      action: "dm",
      args: { refs: [`tgfake:${chatId}`] },
    });

    expect(isConnectorActionSkipped(result)).toBe(true);
    expect(result).toMatchObject({ reason: "channel_unsubscribed" });
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("delivers to the same identified contact when subscribed (no false positive from the new legs)", async () => {
    const chatId = `${RUN}-556`;
    const appExtId = `${RUN}-app-ext-ok`;
    const email = `${RUN}-idlink-ok@example.com`;
    await seedContact({
      email,
      externalId: appExtId,
      properties: { tgfake: { chat_id: chatId, id: chatId } },
    });
    await seedPref({ userId: appExtId, email, categories: { fakeconn: true } });

    const result = await sendConnectorAction({
      connectorId: "fakeconn",
      action: "dm",
      args: { refs: [`tgfake:${chatId}`] },
    });

    expect(isConnectorActionSkipped(result)).toBe(false);
    expect(result).toMatchObject({ messageId: "m1", delivered: true });
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it("allows a group-chat-style namespaced ref that resolves no contact", async () => {
    const result = await sendConnectorAction({
      connectorId: "fakeconn",
      action: "dm",
      args: { refs: [`tgfake:-100999${RUN}`] },
    });

    expect(isConnectorActionSkipped(result)).toBe(false);
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it("regression: a raw un-namespaced ref still resolves via the existing legs and gates", async () => {
    const email = `${RUN}-raw@example.com`;
    const externalId = `${RUN}-raw`;
    await seedContact({ email, externalId });
    await seedPref({
      userId: externalId,
      email,
      categories: { fakeconn: false },
    });

    // A plain external-id ref (no namespace) takes the unchanged externalId leg.
    const result = await sendConnectorAction({
      connectorId: "fakeconn",
      action: "dm",
      args: { refs: [externalId] },
    });

    expect(isConnectorActionSkipped(result)).toBe(true);
    expect(result).toMatchObject({ reason: "channel_unsubscribed" });
    expect(runSpy).not.toHaveBeenCalled();
  });
});
