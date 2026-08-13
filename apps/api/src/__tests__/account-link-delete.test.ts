import { afterAll, describe, expect, it, vi } from "vitest";

// Same real test DB the engine singletons + the route container read.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contactAliases, contacts, createDatabase, linkedAccounts } =
  await import("@hogsend/db");
const { and, eq, inArray, isNull, like, or } = await import("drizzle-orm");
const engine = await import("@hogsend/engine");
const {
  createApp,
  createHogsendClient,
  getLiveLink,
  linkAccount,
  listLinkHistory,
  resolveOrCreateContact,
  unlinkAccountsForContactInTx,
} = engine;
// `softDeleteContact` is not on the main barrel (routes call it relatively);
// tests reach it through the `/testing` subpath.
const { softDeleteContact } = await import("@hogsend/engine/testing");

const { db, client } = createDatabase({
  url: process.env.DATABASE_URL as string,
});

type HogsendClient = ReturnType<typeof createHogsendClient>;
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

const ADMIN_HEADERS = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
  "Content-Type": "application/json",
};

// PRD 04 T5 — run-namespaced rows, cleanup scoped to exactly this namespace.
const RUN = `aldel-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

let seq = 0;
const uid = (label: string) => `${RUN}-${label}-${seq++}`;
const prov = (label: string) => `${RUN}-${label}`;

type LinkInput = Parameters<typeof linkAccount>[0];

function linkInput(
  over: Partial<LinkInput> & {
    contactId: string;
    provider: string;
    identity: LinkInput["identity"];
  },
): LinkInput {
  return {
    db,
    method: "oauth",
    multiple: true,
    onConflict: "replace",
    storeTokens: false,
    allowDisplaceLiveOwner: false,
    ...over,
  };
}

async function mustLink(input: LinkInput) {
  const result = await linkAccount(input);
  if (result.status !== "linked") {
    throw new Error(`seed link failed: ${JSON.stringify(result)}`);
  }
  return result;
}

afterAll(async () => {
  await db
    .delete(linkedAccounts)
    .where(like(linkedAccounts.provider, `${RUN}-%`));
  const rows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      or(
        like(contacts.externalId, `${RUN}-%`),
        like(contacts.anonymousId, `${RUN}-%`),
        like(contacts.email, `${RUN}-%`),
      ),
    );
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    await db
      .delete(contactAliases)
      .where(
        or(
          inArray(contactAliases.contactId, ids),
          inArray(contactAliases.fromContactId, ids),
        ),
      );
    await db.delete(contacts).where(inArray(contacts.id, ids));
  }
  await client.end();
});

describe("account links — contact deletion (PRD 04 T5, DECISIONS §15.3)", () => {
  it("a soft-deleted contact holds no live link", async () => {
    const provider = prov("t5-nolive");
    const userId = uid("ext");
    const contact = await resolveOrCreateContact({ db, userId });
    await mustLink(
      linkInput({
        contactId: contact.id,
        provider,
        identity: { providerUserId: uid("a") },
      }),
    );
    await mustLink(
      linkInput({
        contactId: contact.id,
        provider,
        identity: { providerUserId: uid("b") },
      }),
    );

    const result = await softDeleteContact({ db, userId });
    expect(result.deleted).toBe(true);

    const live = await db
      .select({ id: linkedAccounts.id })
      .from(linkedAccounts)
      .where(
        and(
          eq(linkedAccounts.contactId, contact.id),
          isNull(linkedAccounts.unlinkedAt),
        ),
      );
    expect(live).toEqual([]);
  });

  it("each deleted link gets its own pair's next version", async () => {
    const provider = prov("t5-versions");
    const userId = uid("ext");
    const contact = await resolveOrCreateContact({ db, userId });
    const pairA = uid("a");
    const pairB = uid("b");
    // pairA: fresh (v1 live → unlink at 2). pairB: deep history (v1 on a
    // bystander, unlinked v2, relinked to the contact at v3 → unlink at 4).
    await mustLink(
      linkInput({
        contactId: contact.id,
        provider,
        identity: { providerUserId: pairA },
      }),
    );
    const bystander = await resolveOrCreateContact({
      db,
      userId: uid("bystander"),
    });
    await mustLink(
      linkInput({
        contactId: bystander.id,
        provider,
        identity: { providerUserId: pairB },
      }),
    );
    await engine.unlinkAccount({
      db,
      provider,
      providerUserId: pairB,
      reason: "player",
    });
    await mustLink(
      linkInput({
        contactId: contact.id,
        provider,
        identity: { providerUserId: pairB },
      }),
    );

    // pairC: seeded so the delete unlink lands on the ODD 9007199254740995 —
    // every even integer below 2^54 is float64-exact, so only an odd value
    // above 2^53 catches a Number() on the path (DECISIONS §5.1).
    const pairC = uid("c");
    await db.insert(linkedAccounts).values([
      {
        contactId: contact.id,
        provider,
        providerUserId: pairC,
        method: "oauth",
        singleton: false,
        version: 9007199254740994n,
        unlinkedAt: new Date(),
        unlinkReason: "player",
      },
      {
        contactId: contact.id,
        provider,
        providerUserId: pairC,
        method: "oauth",
        singleton: false,
        version: 2n,
      },
    ]);

    const result = await softDeleteContact({ db, userId });
    expect(result.deleted).toBe(true);

    const byPair = new Map(
      (result.linkUnlinks ?? []).map((f) => [f.providerUserId, f]),
    );
    // Each pair's OWN next version — not a copy, not a shared value.
    expect(byPair.get(pairA)?.version).toBe("2");
    expect(byPair.get(pairB)?.version).toBe("4");
    expect(byPair.get(pairC)?.version).toBe("9007199254740995");
    expect(byPair.get(pairA)?.reason).toBe("api");
    const [histA] = await listLinkHistory({
      db,
      provider,
      providerUserId: pairA,
    });
    expect(histA?.unlinkReason).toBe("api");
  });

  it("deleting a contact nulls the token blob", async () => {
    const provider = prov("t5-tokens");
    const userId = uid("ext");
    const contact = await resolveOrCreateContact({ db, userId });
    const pair = uid("u");
    await mustLink(
      linkInput({
        contactId: contact.id,
        provider,
        identity: {
          providerUserId: pair,
          tokens: { accessToken: `${RUN}-secret-token` },
        },
        storeTokens: true,
      }),
    );
    const [seeded] = await db
      .select({ tokens: linkedAccounts.tokens })
      .from(linkedAccounts)
      .where(
        and(
          eq(linkedAccounts.provider, provider),
          eq(linkedAccounts.providerUserId, pair),
        ),
      );
    expect(seeded?.tokens).not.toBeNull();

    await softDeleteContact({ db, userId });

    const [after] = await db
      .select({ tokens: linkedAccounts.tokens })
      .from(linkedAccounts)
      .where(
        and(
          eq(linkedAccounts.provider, provider),
          eq(linkedAccounts.providerUserId, pair),
        ),
      );
    expect(after?.tokens).toBeNull();
  });

  it("an erasure nulls verified_email, username and avatar_url but keeps the version", async () => {
    const provider = prov("t5-erase");
    const userId = uid("ext");
    const contact = await resolveOrCreateContact({ db, userId });
    const pair = uid("u");
    // Two rows for the pair: a historical one (v1 → unlinked at 2) and a live
    // one (v3). Erasure must strip personal fields from BOTH while the
    // version sequence survives.
    await mustLink(
      linkInput({
        contactId: contact.id,
        provider,
        identity: {
          providerUserId: pair,
          username: `${RUN}-old-name`,
          verifiedEmail: `${RUN}-old@example.com`,
          avatarUrl: "https://example.com/old.png",
        },
      }),
    );
    await engine.unlinkAccount({
      db,
      provider,
      providerUserId: pair,
      reason: "player",
    });
    await mustLink(
      linkInput({
        contactId: contact.id,
        provider,
        identity: {
          providerUserId: pair,
          username: `${RUN}-name`,
          verifiedEmail: `${RUN}-me@example.com`,
          avatarUrl: "https://example.com/a.png",
        },
      }),
    );

    // The admin delete route is the erasure hook.
    const res = await app.request(`/v1/admin/contacts/${contact.id}`, {
      method: "DELETE",
      headers: ADMIN_HEADERS,
    });
    expect(res.status).toBe(200);

    const rows = await db
      .select()
      .from(linkedAccounts)
      .where(
        and(
          eq(linkedAccounts.provider, provider),
          eq(linkedAccounts.providerUserId, pair),
        ),
      );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.username).toBeNull();
      expect(row.verifiedEmail).toBeNull();
      expect(row.avatarUrl).toBeNull();
      expect(row.tokens).toBeNull();
      expect(row.unlinkedAt).not.toBeNull();
    }
    // The version sequence stays monotonic across erasure.
    expect(rows.map((r) => String(r.version)).sort()).toEqual(["2", "4"]);
  });

  it("a pair whose owner was deleted can be relinked under onConflict reject", async () => {
    // THE player-facing criterion: without the delete-leg unlink, the live row
    // outlives its owner, the pair stays permanently owned, and an erased
    // player can never relink their own account — this linkAccount would
    // return { status: "rejected", reason: "live_owner_conflict" }.
    const provider = prov("t5-relink");
    const userId = uid("ext");
    const pair = uid("u");
    const erased = await resolveOrCreateContact({ db, userId });
    await mustLink(
      linkInput({
        contactId: erased.id,
        provider,
        identity: { providerUserId: pair },
        multiple: false,
        onConflict: "reject",
      }),
    );

    await softDeleteContact({ db, userId });

    // The player re-registers as a fresh contact and relinks the SAME account.
    const fresh = await resolveOrCreateContact({ db, userId: uid("fresh") });
    const relinked = await linkAccount(
      linkInput({
        contactId: fresh.id,
        provider,
        identity: { providerUserId: pair },
        multiple: false,
        onConflict: "reject",
      }),
    );
    expect(relinked.status).toBe("linked");
    const live = await getLiveLink({ db, provider, providerUserId: pair });
    expect(live?.contactId).toBe(fresh.id);
  });

  it("deletion returns one unlink fact per live link", async () => {
    const providerA = prov("t5-facts-a");
    const providerB = prov("t5-facts-b");
    const userId = uid("ext");
    const contact = await resolveOrCreateContact({ db, userId });
    const pairA = uid("a");
    const pairB = uid("b");
    await mustLink(
      linkInput({
        contactId: contact.id,
        provider: providerA,
        identity: { providerUserId: pairA },
      }),
    );
    await mustLink(
      linkInput({
        contactId: contact.id,
        provider: providerB,
        identity: { providerUserId: pairB },
      }),
    );

    const result = await softDeleteContact({ db, userId });

    expect(result.linkUnlinks).toHaveLength(2);
    const providers = (result.linkUnlinks ?? []).map((f) => f.provider).sort();
    expect(providers).toEqual([providerA, providerB].sort());
    for (const fact of result.linkUnlinks ?? []) {
      expect(fact.contactId).toBe(contact.id);
      expect(fact.reason).toBe("api");
      expect(typeof fact.version).toBe("string");
      expect(fact.owner.contactId).toBe(contact.id);
    }
  });

  it("deleting a contact with no links is a no-op and returns an empty array", async () => {
    const userId = uid("ext");
    const contact = await resolveOrCreateContact({ db, userId });

    // The helper itself: idempotent by construction — no live rows, empty
    // array, no throw. (A second call after a delete behaves identically.)
    const direct = await db.transaction((tx) =>
      unlinkAccountsForContactInTx(tx, contact.id, { reason: "api" }),
    );
    expect(direct).toEqual([]);

    const result = await softDeleteContact({ db, userId });
    expect(result.deleted).toBe(true);
    expect(result.linkUnlinks).toBeUndefined();

    const again = await db.transaction((tx) =>
      unlinkAccountsForContactInTx(tx, contact.id, { reason: "api" }),
    );
    expect(again).toEqual([]);
  });
});
