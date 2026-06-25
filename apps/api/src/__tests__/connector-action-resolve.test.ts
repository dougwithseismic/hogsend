import type { HogsendClient, ResolvedActionContact } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Hatchet via the override seam — `sendConnectorAction` outside a journey
// boundary runs the action directly (getJourneyBoundary() is undefined here),
// so the only engine machinery touched is the REAL `resolveContact`. The mock
// keeps `createHogsendClient` from trying to reach a live engine at boot.
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

const { contacts } = await import("@hogsend/db");
const { inArray } = await import("drizzle-orm");
const { createHogsendClient, defineConnectorAction, sendConnectorAction } =
  await import("@hogsend/engine");

// A tiny test action that does nothing but echo the resolver's verdict — the
// load-bearing proof runs THROUGH the public `sendConnectorAction` surface, so
// `ctx.resolveContact` is the real engine resolver (Fix B), never a stub.
const testAction = defineConnectorAction<
  { ref: string },
  ResolvedActionContact | null
>({
  connectorId: "test",
  name: "resolve",
  run: async (args, ctx) => ctx.resolveContact(args.ref),
});

const container = createHogsendClient({
  connectorActions: [testAction],
  overrides: { hatchet: mockHatchet },
});
const { db } = container;

const RUN = `car-${Date.now()}`;
const createdContactIds: string[] = [];

/** Drive the resolver through the PUBLIC outbound-action surface. */
async function call(ref: string): Promise<ResolvedActionContact | null> {
  return (await sendConnectorAction({
    connectorId: "test",
    action: "resolve",
    args: { ref },
  })) as ResolvedActionContact | null;
}

async function seed(
  values: Partial<typeof contacts.$inferInsert>,
): Promise<typeof contacts.$inferSelect> {
  const [row] = await db.insert(contacts).values(values).returning();
  if (!row) throw new Error("seed: insert returned no row");
  createdContactIds.push(row.id);
  return row;
}

afterAll(async () => {
  if (createdContactIds.length > 0) {
    await db.delete(contacts).where(inArray(contacts.id, createdContactIds));
  }
  await container.dbClient.end({ timeout: 5 }).catch(() => {});
});

describe("sendConnectorAction resolveContact (Fix B: uuid id + anonymous_id)", () => {
  it("(a) resolves an anonymous Discord-only contact by its uuid id", async () => {
    // No email / externalId / anonymousId — the ONLY non-uuid key is the
    // discordId. Before Fix B, `member: user.id` (a uuid) hit none of the text
    // columns and resolved null; now the uuid leg matches the `id` column.
    const row = await seed({ discordId: "987654321098765432" });
    const result = await call(row.id);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(row.id);
    expect(result?.discordId).toBe("987654321098765432");
  });

  it("(b) resolves a contact by its anonymous_id", async () => {
    const anon = `${RUN}-anon`;
    const row = await seed({
      anonymousId: anon,
      discordId: "222000111222000111",
    });
    const result = await call(anon);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(row.id);
    expect(result?.discordId).toBe("222000111222000111");
  });

  it("(c) regression: email / external_id / discord_id refs still resolve", async () => {
    const email = `${RUN}-all@example.com`;
    const externalId = `${RUN}-ext`;
    const discordId = "333000111333000111";
    const row = await seed({ email, externalId, discordId });

    for (const ref of [email, externalId, discordId]) {
      const result = await call(ref);
      expect(result, `ref ${ref} should resolve`).not.toBeNull();
      expect(result?.id).toBe(row.id);
    }
  });

  it("(d) an email-shaped ref with no match returns null and does NOT throw (cast gate)", async () => {
    // The guard that keeps Fix B safe: a non-uuid ref must NEVER reach the uuid
    // `id` leg (an email cast to uuid would raise a 22P02 invalid-input error).
    const ref = `${RUN}-nobody@example.com`;
    await expect(call(ref)).resolves.toBeNull();
  });

  it("(e) a bare snowflake ref with no matching contact returns null, no throw", async () => {
    await expect(call("404000111404000111")).resolves.toBeNull();
  });
});
