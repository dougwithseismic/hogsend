import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Same real test DB the engine singletons + the route container read.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// PRD 08 T3: the merge and delete legs now emit `account.unlinked` post-commit
// through the fire-and-forget spine, which enqueues the MODULE-LEVEL
// `deliverWebhookTask` built from the engine's `lib/hatchet.ts` singleton at
// import time — NOT a container hatchet. Mock the singleton itself (the
// groups-outbound idiom) so the delivery row lands without a live gRPC dial.
const { hatchetMock } = vi.hoisted(() => {
  const runNoWait = vi.fn(async (_input: { deliveryId: string }) => ({}));
  const factory = () => ({
    hatchet: {
      durableTask: vi.fn((config: Record<string, unknown>) => ({
        ...config,
        run: vi.fn(),
        runNoWait: vi.fn(),
        runAndWait: vi.fn(),
      })),
      task: vi.fn((config: Record<string, unknown>) => ({
        ...config,
        run: vi.fn(),
        runNoWait,
      })),
      events: { push: vi.fn() },
      runs: { cancel: vi.fn(), get: vi.fn() },
      worker: vi.fn(),
    },
  });
  return { hatchetMock: factory };
});

vi.mock("../../../../packages/engine/src/lib/hatchet.ts", () => hatchetMock());
vi.mock("../lib/hatchet.js", () => hatchetMock());

const {
  contactAliases,
  contacts,
  createDatabase,
  linkedAccounts,
  webhookDeliveries,
  webhookEndpoints,
} = await import("@hogsend/db");
const { and, eq, inArray, like, or, sql } = await import("drizzle-orm");
const engine = await import("@hogsend/engine");
const {
  createApp,
  createHogsendClient,
  emitOutbound,
  getLiveLink,
  linkAccount,
  listLinkHistory,
  resolveOrCreateContact,
} = engine;
// ALL_IDENTITY_KINDS is deliberately NOT on the main barrel (it is the
// resolver's internal full-trust grant, not public API) — the guard test
// reaches it through the `/testing` subpath, same as the store's lock
// mechanics. `softDeleteContact` is route-internal there for the same reason.
const { ALL_IDENTITY_KINDS, softDeleteContact } = await import(
  "@hogsend/engine/testing"
);

const { db, client } = createDatabase({
  url: process.env.DATABASE_URL as string,
});

// The REAL admin router, for the erasure leg. `DELETE /v1/admin/contacts/:id`
// runs its OWN transaction instead of going through `softDeleteContact`, so it
// is an independent emit owner and needs its own delivery assertion — deleting
// its `emitAccountUnlinked` line leaves every other test in this repo green.
// The hatchet singleton is already mocked above, so the container's override
// only pins the same handle explicitly.
const container = createHogsendClient({
  overrides: { hatchet: engine.hatchet },
});
const app = createApp(container);

const ADMIN_HEADERS = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
  "Content-Type": "application/json",
};

// PRD 04 — every row this suite creates carries this per-run prefix, and
// `afterAll` deletes exactly this namespace (resolve-policy-trusted-kinds
// idiom). Row assertions are always scoped to the namespace, never a
// whole-table count.
const RUN = `almerge-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

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

/**
 * Two contacts destined to merge: A identified by external id (the survivor —
 * pickSurvivor prefers identified), B anonymous-only (the loser). Returns the
 * ids plus the keys a later `resolveOrCreateContact({ userId, anonymousId })`
 * collides on.
 */
async function makeMergePair(label: string): Promise<{
  survivorId: string;
  loserId: string;
  userId: string;
  anonymousId: string;
}> {
  const userId = uid(`${label}-ext`);
  const anonymousId = uid(`${label}-anon`);
  const a = await resolveOrCreateContact({ db, userId });
  const b = await resolveOrCreateContact({ db, anonymousId });
  return { survivorId: a.id, loserId: b.id, userId, anonymousId };
}

async function merge(userId: string, anonymousId: string) {
  return resolveOrCreateContact({ db, userId, anonymousId });
}

async function mustLink(input: LinkInput) {
  const result = await linkAccount(input);
  if (result.status !== "linked") {
    throw new Error(`seed link failed: ${JSON.stringify(result)}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// PRD 08 T3 — the outbound `account.unlinked` fixture
// ---------------------------------------------------------------------------

/** The one endpoint subscribed to `account.unlinked` for this run. */
let endpointId = "";

type UnlinkedData = {
  state: string;
  provider: string;
  providerUserId: string;
  contactId: string;
  userId: string | null;
  email: string | null;
  reason: string;
  version: string;
  at: string;
};

/**
 * Delivery rows for THIS run's endpoint whose dedupe key belongs to `provider`.
 *
 * Scoped by the RUN-prefixed provider rather than by event type alone: the emit
 * spine fans out to every subscribed `organizationId IS NULL` endpoint, so a
 * count filtered only on `eventType` is a count of whatever else the process
 * emitted. Every assertion below is `toHaveLength(n)` against this, never
 * `toBeGreaterThan(0)`.
 */
async function deliveriesFor(provider: string) {
  const rows = await db
    .select({
      id: webhookDeliveries.id,
      eventType: webhookDeliveries.eventType,
      dedupeKey: webhookDeliveries.dedupeKey,
      payload: webhookDeliveries.payload,
    })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.endpointId, endpointId),
        like(webhookDeliveries.dedupeKey, `al:${provider}:%`),
      ),
    );
  return rows.map((r) => ({
    ...r,
    data: (r.payload as { data: UnlinkedData }).data,
  }));
}

/**
 * The emits are fire-and-forget (`void emitOutbound(...)`), so the mutation
 * resolves before the emit's INSERT lands — poll until `expected` rows appear.
 */
async function waitForDeliveries(
  provider: string,
  expected: number,
  timeoutMs = 5000,
) {
  const start = Date.now();
  let rows = await deliveriesFor(provider);
  while (rows.length < expected && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 25));
    rows = await deliveriesFor(provider);
  }
  return rows;
}

/**
 * For the NEGATIVE assertions ("emits nothing"): polling cannot prove absence,
 * so give the fire-and-forget path a generous, fixed window to land a row it
 * must never land. The positive tests above measure single-digit ms.
 */
const SETTLE_MS = 750;

beforeAll(async () => {
  const [row] = await db
    .insert(webhookEndpoints)
    .values({
      url: `https://example.com/${RUN}/account-sink`,
      secret: "whsec_dGVzdHNlY3JldGZvcmVtaXRwb2ludGNvdmVyYWdldGVzdA==",
      secretPrefix: "whsec_dGVzd",
      eventTypes: ["account.unlinked"],
      disabled: false,
    })
    .returning({ id: webhookEndpoints.id });
  endpointId = row?.id ?? "";
});

afterAll(async () => {
  // Deliveries cascade with the endpoint (FK onDelete: "cascade").
  if (endpointId) {
    await db
      .delete(webhookEndpoints)
      .where(eq(webhookEndpoints.id, endpointId));
  }
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

describe("account links — contact merge repoint (PRD 04 T2)", () => {
  it("merge repoints the loser's live links to the survivor", async () => {
    const provider = prov("t2-live");
    const { survivorId, loserId, userId, anonymousId } =
      await makeMergePair("t2-live");
    const pairA = uid("a");
    const pairB = uid("b");
    const before = await mustLink(
      linkInput({
        contactId: loserId,
        provider,
        identity: { providerUserId: pairA },
      }),
    );
    await mustLink(
      linkInput({
        contactId: loserId,
        provider,
        identity: { providerUserId: pairB },
      }),
    );

    const result = await merge(userId, anonymousId);
    expect(result.id).toBe(survivorId);
    expect(result.merged).toBe(true);

    // Both rows live, both owned by the survivor, version/method/linkedAt
    // PRESERVED (a repoint is not a state transition, DECISIONS §5).
    for (const pair of [pairA, pairB]) {
      const live = await getLiveLink({ db, provider, providerUserId: pair });
      expect(live?.contactId).toBe(survivorId);
      expect(live?.version).toBe("1");
      expect(live?.method).toBe("oauth");
    }
    const liveA = await getLiveLink({ db, provider, providerUserId: pairA });
    expect(liveA?.linkedAt.getTime()).toBe(before.row.linkedAt.getTime());
    // No unlink happened, so the merge reports no link facts.
    expect(result.linkUnlinks).toBeUndefined();
  });

  it("merge repoints the loser's historical unlinked links", async () => {
    const provider = prov("t2-hist");
    const { survivorId, loserId, userId, anonymousId } =
      await makeMergePair("t2-hist");
    const pair = uid("u");
    // A historical row: link then unlink (v1 → unlinked at v2).
    await mustLink(
      linkInput({
        contactId: loserId,
        provider,
        identity: { providerUserId: pair },
      }),
    );
    const unlinked = await engine.unlinkAccount({
      db,
      provider,
      providerUserId: pair,
      reason: "player",
    });
    expect(unlinked.status).toBe("unlinked");

    await merge(userId, anonymousId);

    const [row] = await listLinkHistory({ db, provider, providerUserId: pair });
    expect(row?.contactId).toBe(survivorId);
    expect(row?.version).toBe("2");
    expect(row?.unlinkReason).toBe("player");
    // Nothing still references the soft-deleted loser.
    const strays = await db
      .select({ id: linkedAccounts.id })
      .from(linkedAccounts)
      .where(eq(linkedAccounts.contactId, loserId));
    expect(strays).toEqual([]);
  });

  it("merge leaves both live when the provider is multiple:true", async () => {
    const provider = prov("t2-multi");
    const { survivorId, loserId, userId, anonymousId } =
      await makeMergePair("t2-multi");
    const pairS = uid("s");
    const pairL = uid("l");
    await mustLink(
      linkInput({
        contactId: survivorId,
        provider,
        identity: { providerUserId: pairS },
      }),
    );
    await mustLink(
      linkInput({
        contactId: loserId,
        provider,
        identity: { providerUserId: pairL },
      }),
    );

    const result = await merge(userId, anonymousId);

    // `multiple: true` needs no arbitration (DECISIONS §7): both stay live.
    for (const pair of [pairS, pairL]) {
      const live = await getLiveLink({ db, provider, providerUserId: pair });
      expect(live?.contactId).toBe(survivorId);
      expect(live?.unlinkedAt).toBeNull();
    }
    expect(result.linkUnlinks).toBeUndefined();
  });

  it("merge soft-unlinks the loser's singleton link and keeps the survivor's", async () => {
    const provider = prov("t2-singleton");
    const { survivorId, loserId, userId, anonymousId } =
      await makeMergePair("t2-singleton");
    const pairS = uid("s");
    const pairL = uid("l");
    await mustLink(
      linkInput({
        contactId: survivorId,
        provider,
        identity: { providerUserId: pairS },
        multiple: false,
      }),
    );
    await mustLink(
      linkInput({
        contactId: loserId,
        provider,
        identity: { providerUserId: pairL },
        multiple: false,
      }),
    );

    await merge(userId, anonymousId);

    // Survivor's row: still live, untouched.
    const liveS = await getLiveLink({ db, provider, providerUserId: pairS });
    expect(liveS?.contactId).toBe(survivorId);
    expect(liveS?.version).toBe("1");
    // Loser's row: soft-unlinked with reason "relinked", and REPOINTED to the
    // survivor so no row references the soft-deleted loser.
    expect(
      await getLiveLink({ db, provider, providerUserId: pairL }),
    ).toBeNull();
    const [histL] = await listLinkHistory({
      db,
      provider,
      providerUserId: pairL,
    });
    expect(histL?.unlinkReason).toBe("relinked");
    expect(histL?.contactId).toBe(survivorId);
    expect(histL?.version).toBe("2");
  });

  it("the merge-unlinked row's version is that pair's next version, not a copy", async () => {
    const provider = prov("t2-nextv");
    const { survivorId, loserId, userId, anonymousId } =
      await makeMergePair("t2-nextv");
    const pairS = uid("s");
    const pairL = uid("l");
    await mustLink(
      linkInput({
        contactId: survivorId,
        provider,
        identity: { providerUserId: pairS },
        multiple: false,
      }),
    );
    // Give the loser's pair its own DEEP history: link to a bystander (v1),
    // unlink (v2), then relink to the loser (v3, live).
    const bystander = await resolveOrCreateContact({
      db,
      userId: uid("bystander"),
    });
    await mustLink(
      linkInput({
        contactId: bystander.id,
        provider,
        identity: { providerUserId: pairL },
      }),
    );
    await engine.unlinkAccount({
      db,
      provider,
      providerUserId: pairL,
      reason: "player",
    });
    await mustLink(
      linkInput({
        contactId: loserId,
        provider,
        identity: { providerUserId: pairL },
        multiple: false,
      }),
    );

    const result = await merge(userId, anonymousId);

    // The unlink burns the PAIR's own next version (max 3 → 4), never a copy
    // of another row's version and never a restart at 2.
    const fact = result.linkUnlinks?.find((f) => f.providerUserId === pairL);
    expect(fact?.version).toBe("4");
    const history = await listLinkHistory({
      db,
      provider,
      providerUserId: pairL,
    });
    expect(history.map((r) => r.version)).toContain("4");
  });

  it("merge does not raise 23505 on the singleton index", async () => {
    // The regression this PRD exists for: replace `foldLinkedAccounts` with the
    // blind `UPDATE linked_accounts SET contact_id = survivor` and this resolve
    // rejects with a 23505 on linked_accounts_contact_provider_singleton_idx,
    // aborting an ordinary identify call.
    const provider = prov("t2-23505");
    const { survivorId, loserId, userId, anonymousId } =
      await makeMergePair("t2-23505");
    await mustLink(
      linkInput({
        contactId: survivorId,
        provider,
        identity: { providerUserId: uid("s") },
        multiple: false,
      }),
    );
    await mustLink(
      linkInput({
        contactId: loserId,
        provider,
        identity: { providerUserId: uid("l") },
        multiple: false,
      }),
    );

    await expect(merge(userId, anonymousId)).resolves.toMatchObject({
      id: survivorId,
      merged: true,
    });
  });

  it("no linked_accounts row references a soft-deleted contact after a merge", async () => {
    const provider = prov("t2-nostray");
    const { loserId, userId, anonymousId } = await makeMergePair("t2-nostray");
    await mustLink(
      linkInput({
        contactId: loserId,
        provider,
        identity: { providerUserId: uid("live") },
      }),
    );
    await mustLink(
      linkInput({
        contactId: loserId,
        provider: prov("t2-nostray-b"),
        identity: { providerUserId: uid("other") },
        multiple: false,
      }),
    );

    await merge(userId, anonymousId);

    // The loser is soft-deleted; NOTHING may still point at it (scoped to this
    // run's providers, never a whole-table scan).
    const strayRows = await db
      .select({ id: linkedAccounts.id, contactId: linkedAccounts.contactId })
      .from(linkedAccounts)
      .where(like(linkedAccounts.provider, `${RUN}-t2-nostray%`));
    const owners = [...new Set(strayRows.map((r) => r.contactId))];
    const deletedOwners = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          inArray(contacts.id, owners),
          sql`${contacts.deletedAt} IS NOT NULL`,
        ),
      );
    expect(deletedOwners).toEqual([]);
  });

  it("the merge result reports the unlink facts", async () => {
    const provider = prov("t2-facts");
    const { loserId, survivorId, userId, anonymousId } =
      await makeMergePair("t2-facts");
    const pairS = uid("s");
    const pairL = uid("l");
    await mustLink(
      linkInput({
        contactId: survivorId,
        provider,
        identity: { providerUserId: pairS },
        multiple: false,
      }),
    );
    await mustLink(
      linkInput({
        contactId: loserId,
        provider,
        identity: { providerUserId: pairL },
        multiple: false,
      }),
    );

    const result = await merge(userId, anonymousId);

    expect(result.linkUnlinks).toHaveLength(1);
    const fact = result.linkUnlinks?.[0];
    expect(fact).toMatchObject({
      provider,
      providerUserId: pairL,
      contactId: loserId,
      reason: "relinked",
    });
    // A STRING end to end — never a number (DECISIONS §5.1).
    expect(typeof fact?.version).toBe("string");
    expect(fact?.version).toBe("2");
  });

  it("a version above Number.MAX_SAFE_INTEGER survives the merge unlink", async () => {
    const provider = prov("t2-big");
    const { survivorId, loserId, userId, anonymousId } =
      await makeMergePair("t2-big");
    const pairS = uid("s");
    const pairL = uid("l");
    await mustLink(
      linkInput({
        contactId: survivorId,
        provider,
        identity: { providerUserId: pairS },
        multiple: false,
      }),
    );
    // Seed the loser's pair so the merge unlink lands on the ODD
    // 9007199254740995: a historical row burns 2^53+2 (...994), the live row
    // sits below it, so COALESCE(MAX(version),0)+1 = ...995. Do NOT seed
    // ...993 expecting ...994 — ...994 is even and float64-exact, so a
    // Number() on the path round-trips it unchanged and the assertion passes
    // on broken code (DECISIONS §5.1).
    await db.insert(linkedAccounts).values([
      {
        contactId: loserId,
        provider,
        providerUserId: pairL,
        method: "oauth",
        singleton: false,
        version: 9007199254740994n,
        unlinkedAt: new Date(),
        unlinkReason: "player",
      },
      {
        contactId: loserId,
        provider,
        providerUserId: pairL,
        method: "oauth",
        singleton: true,
        version: 2n,
      },
    ]);

    const result = await merge(userId, anonymousId);

    const fact = result.linkUnlinks?.find((f) => f.providerUserId === pairL);
    expect(fact?.version).toBe("9007199254740995");
    // And the stored column agrees when read back AS TEXT.
    const rows = (await db.execute(sql`
      SELECT version::text AS v FROM linked_accounts
      WHERE provider = ${provider} AND provider_user_id = ${pairL}
      ORDER BY version DESC
    `)) as unknown as Array<{ v: string }>;
    expect(rows[0]?.v).toBe("9007199254740995");
  });
});

describe("account links — adoptOrphanHistory is a proven no-op (PRD 04 T3)", () => {
  it("adoptOrphanHistory leaves a contact's link rows untouched", async () => {
    const provider = prov("t3-adopt");
    const anonymousId = uid("anon");
    const created = await resolveOrCreateContact({ db, anonymousId });
    const pair = uid("u");
    await mustLink(
      linkInput({
        contactId: created.id,
        provider,
        identity: { providerUserId: pair },
      }),
    );
    const [before] = await db
      .select()
      .from(linkedAccounts)
      .where(
        and(
          eq(linkedAccounts.provider, provider),
          eq(linkedAccounts.providerUserId, pair),
        ),
      );
    if (!before) throw new Error("seed link missing");

    // Attach an external id: the canonical key flips anon → external, which
    // drives the adoption pass over the OLD key.
    const linkedResult = await resolveOrCreateContact({
      db,
      userId: uid("ext"),
      anonymousId,
    });
    expect(linkedResult.id).toBe(created.id);

    const [after] = await db
      .select()
      .from(linkedAccounts)
      .where(eq(linkedAccounts.id, before.id));
    expect(after?.contactId).toBe(before.contactId);
    expect(after?.version).toBe(before.version);
    expect(after?.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after?.unlinkedAt).toBeNull();
  });

  it("linked_accounts.contact_id is NOT NULL", async () => {
    // What makes the no-op PROVABLE rather than asserted: `adoptOrphanHistory`
    // stamps rows matching `WHERE user_id = :key AND contact_id IS NULL`, and
    // linked_accounts has NO user_id column and a NOT NULL contact_id — the
    // predicate can never match.
    const cols = (await db.execute(sql`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'linked_accounts'
        AND column_name IN ('contact_id', 'user_id')
    `)) as unknown as Array<{ column_name: string; is_nullable: string }>;
    const contactId = cols.find((c) => c.column_name === "contact_id");
    expect(contactId?.is_nullable).toBe("NO");
    expect(cols.find((c) => c.column_name === "user_id")).toBeUndefined();
  });
});

describe("account links — the identity model is not widened (PRD 04 T4)", () => {
  it("IdentityKind is not widened", async () => {
    // A future PRD that promotes "steam" to a resolver kind has to delete
    // this test deliberately (DECISIONS §7, §12).
    expect([...ALL_IDENTITY_KINDS]).toEqual([
      "external",
      "email",
      "anonymous",
      "discord",
    ]);
  });

  it("merge records no per-provider alias", async () => {
    const provider = prov("t4-alias");
    const { survivorId, loserId, userId, anonymousId } =
      await makeMergePair("t4-alias");
    await mustLink(
      linkInput({
        contactId: loserId,
        provider,
        identity: { providerUserId: uid("l") },
        multiple: false,
      }),
    );
    await mustLink(
      linkInput({
        contactId: survivorId,
        provider,
        identity: { providerUserId: uid("s") },
        multiple: false,
      }),
    );

    await merge(userId, anonymousId);

    const aliases = await db
      .select({ kind: contactAliases.aliasKind })
      .from(contactAliases)
      .where(eq(contactAliases.contactId, survivorId));
    for (const a of aliases) {
      expect(["external", "email", "anonymous", "discord"]).toContain(a.kind);
    }
  });
});

describe("account links — outbound account.unlinked (PRD 08 T3)", () => {
  it("a merge singleton-collision unlink emits one account.unlinked with reason relinked", async () => {
    const provider = prov("t8-merge");
    const { survivorId, loserId, userId, anonymousId } =
      await makeMergePair("t8-merge");
    const pairS = uid("s");
    const pairL = uid("l");
    await mustLink(
      linkInput({
        contactId: survivorId,
        provider,
        identity: { providerUserId: pairS },
        multiple: false,
      }),
    );
    await mustLink(
      linkInput({
        contactId: loserId,
        provider,
        identity: { providerUserId: pairL },
        multiple: false,
      }),
    );

    // The MOVED-BUT-NOT-UNLINKED row, which is the whole point of the silence
    // assertion at the bottom. The survivor holds nothing for this second
    // provider, so step 3 finds no collision and step 4 simply repoints the
    // row to the survivor — a change of ownership, not a new identity fact,
    // and therefore not an emit. Without it the loser has exactly one link,
    // step 4 has nothing left to move, and "one emit, not one per moved row"
    // is a claim about a row the fixture never created.
    const quietProvider = prov("t8-merge-quiet");
    const pairQ = uid("q");
    await mustLink(
      linkInput({
        contactId: loserId,
        provider: quietProvider,
        identity: { providerUserId: pairQ },
        multiple: false,
      }),
    );

    const result = await merge(userId, anonymousId);
    expect(result.linkUnlinks).toHaveLength(1);

    // The repoint really happened — the row moved, live, at its original
    // version.
    const moved = await getLiveLink({
      db,
      provider: quietProvider,
      providerUserId: pairQ,
    });
    expect(moved?.contactId).toBe(survivorId);
    expect(moved?.version).toBe("1");

    const rows = await waitForDeliveries(provider, 1);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.eventType).toBe("account.unlinked");
    // The dedupe key is the PURE template, verbatim segments, `v<version>`.
    expect(row?.dedupeKey).toBe(`al:${provider}:${pairL}:v2`);
    expect(row?.data).toMatchObject({
      state: "unlinked",
      provider,
      providerUserId: pairL,
      contactId: loserId,
      reason: "relinked",
      // A decimal STRING, never a JSON number (DECISIONS §5.1).
      version: "2",
    });
    expect(typeof row?.data.version).toBe("string");
    // `userId`/`email` come off the store's `owner` block — the loser is
    // anon-only, so its contactKey is the anonymous id, not the survivor's.
    expect(row?.data.userId).toBe(anonymousId);
    expect(row?.data.email).toBeNull();

    // The repoint leg is deliberately silent: one emit for the one link that
    // actually ended, not one per moved row. `quietProvider`'s row moved to
    // the survivor in step 4 of `foldLinkedAccounts` and must announce
    // NOTHING; add an emit there and this line fails.
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    expect(await deliveriesFor(quietProvider)).toHaveLength(0);
    expect(await deliveriesFor(provider)).toHaveLength(1);
  });

  it("a rolled-back merge emits nothing", async () => {
    const provider = prov("t8-rollback");
    const { survivorId, loserId, userId, anonymousId } =
      await makeMergePair("t8-rollback");
    const pairS = uid("s");
    const pairL = uid("l");
    await mustLink(
      linkInput({
        contactId: survivorId,
        provider,
        identity: { providerUserId: pairS },
        multiple: false,
      }),
    );
    const seeded = await mustLink(
      linkInput({
        contactId: loserId,
        provider,
        identity: { providerUserId: pairL },
        multiple: false,
      }),
    );

    // FORCE the rollback rather than skipping the path: wrap `db.transaction`
    // so the resolver's callback runs to completion — locks taken, fold done,
    // the loser's link soft-unlinked at its new version — and only THEN throws
    // inside the transaction. Postgres rolls back, `db.transaction` rejects,
    // and the post-commit emit line is never reached. A test that merely
    // avoided the code path could not fail.
    class ForcedRollback extends Error {}
    let captured: { linkUnlinks?: unknown[] } | undefined;
    const rollbackDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return async (cb: (tx: unknown) => Promise<unknown>) =>
            target.transaction(async (tx) => {
              captured = (await cb(tx)) as { linkUnlinks?: unknown[] };
              throw new ForcedRollback("forced rollback after the fold");
            });
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof db;

    await expect(
      resolveOrCreateContact({ db: rollbackDb, userId, anonymousId }),
    ).rejects.toBeInstanceOf(ForcedRollback);

    // The fold DID run and DID produce a fact — this is what makes the zero
    // below meaningful rather than vacuous.
    expect(captured?.linkUnlinks).toHaveLength(1);

    // And the rollback really rolled back: the loser's link is live again at
    // its original version, and the two contacts never merged.
    const live = await getLiveLink({ db, provider, providerUserId: pairL });
    expect(live?.id).toBe(seeded.row.id);
    expect(live?.unlinkedAt).toBeNull();
    const [loser] = await db
      .select({ deletedAt: contacts.deletedAt })
      .from(contacts)
      .where(eq(contacts.id, loserId));
    expect(loser?.deletedAt).toBeNull();

    await new Promise((r) => setTimeout(r, SETTLE_MS));
    expect(await deliveriesFor(provider)).toHaveLength(0);
  });

  it("deleting a contact emits one account.unlinked per live link with reason api", async () => {
    const provider = prov("t8-delete");
    const userId = uid("del-ext");
    const contact = await resolveOrCreateContact({ db, userId });
    const pairA = uid("a");
    const pairB = uid("b");
    await mustLink(
      linkInput({
        contactId: contact.id,
        provider,
        identity: { providerUserId: pairA },
      }),
    );
    await mustLink(
      linkInput({
        contactId: contact.id,
        provider,
        identity: { providerUserId: pairB },
      }),
    );

    const result = await softDeleteContact({ db, userId });
    expect(result.deleted).toBe(true);
    expect(result.linkUnlinks).toHaveLength(2);

    const rows = await waitForDeliveries(provider, 2);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.eventType).toBe("account.unlinked");
      expect(row.data).toMatchObject({
        state: "unlinked",
        provider,
        contactId: contact.id,
        userId,
        reason: "api",
        version: "2",
      });
    }
    expect(rows.map((r) => r.data.providerUserId).sort()).toEqual(
      [pairA, pairB].sort(),
    );
    expect(rows.map((r) => r.dedupeKey).sort()).toEqual(
      [`al:${provider}:${pairA}:v2`, `al:${provider}:${pairB}:v2`].sort(),
    );
  });

  it("the admin erasure route emits one account.unlinked per live link with reason api", async () => {
    // The GDPR-erasure path (DECISIONS §15.3). It is a THIRD emit owner: it
    // does not call `softDeleteContact`, so the sibling test above cannot
    // cover it, and an erased player announced to nobody stays linked in the
    // customer's mirror forever.
    const provider = prov("t8-route-erase");
    const userId = uid("erase-ext");
    const contact = await resolveOrCreateContact({ db, userId });
    const pairA = uid("a");
    const pairB = uid("b");
    await mustLink(
      linkInput({
        contactId: contact.id,
        provider,
        identity: { providerUserId: pairA },
      }),
    );
    await mustLink(
      linkInput({
        contactId: contact.id,
        provider,
        identity: { providerUserId: pairB },
      }),
    );

    const res = await app.request(`/v1/admin/contacts/${contact.id}`, {
      method: "DELETE",
      headers: ADMIN_HEADERS,
    });
    expect(res.status).toBe(200);

    const rows = await waitForDeliveries(provider, 2);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.eventType).toBe("account.unlinked");
      expect(row.data).toMatchObject({
        state: "unlinked",
        provider,
        contactId: contact.id,
        userId,
        reason: "api",
        version: "2",
      });
    }
    expect(rows.map((r) => r.data.providerUserId).sort()).toEqual(
      [pairA, pairB].sort(),
    );
    expect(rows.map((r) => r.dedupeKey).sort()).toEqual(
      [`al:${provider}:${pairA}:v2`, `al:${provider}:${pairB}:v2`].sort(),
    );
  });

  it("a duplicate emit at the same version inserts no second delivery row", async () => {
    const provider = prov("t8-dupe");
    const userId = uid("dupe-ext");
    const contact = await resolveOrCreateContact({ db, userId });
    const pair = uid("u");
    await mustLink(
      linkInput({
        contactId: contact.id,
        provider,
        identity: { providerUserId: pair },
      }),
    );

    const result = await softDeleteContact({ db, userId });
    const fact = result.linkUnlinks?.[0];
    if (!fact) throw new Error("delete produced no unlink fact");
    expect(await waitForDeliveries(provider, 1)).toHaveLength(1);

    // The RETRY shape: the identical event at the identical version, which is
    // what a re-driven producer replays. `(endpointId, dedupeKey)` is
    // partial-unique and `emitOutbound` does `onConflictDoNothing` on it, so
    // the second emit must write nothing.
    const dedupeKey = `al:${provider}:${pair}:v${fact.version}`;
    await emitOutbound({
      db,
      hatchet: engine.hatchet,
      logger: engine.createLogger("error"),
      event: "account.unlinked",
      dedupeKey,
      payload: {
        state: "unlinked",
        provider,
        providerUserId: pair,
        contactId: contact.id,
        userId,
        email: null,
        reason: "api",
        version: fact.version,
        at: new Date().toISOString(),
      },
    });

    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const rows = await deliveriesFor(provider);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dedupeKey).toBe(dedupeKey);
  });

  it("an emit failure does not fail the mutation", async () => {
    const provider = prov("t8-emitfail");
    const userId = uid("fail-ext");
    const contact = await resolveOrCreateContact({ db, userId });
    const pair = uid("u");
    await mustLink(
      linkInput({
        contactId: contact.id,
        provider,
        identity: { providerUserId: pair },
      }),
    );

    // ACTUALLY make the emit fail. `softDeleteContact` reaches the database
    // only through `db.transaction`; the post-commit emit is the one caller of
    // `db.select` on this handle, so poisoning `select` breaks the emit's
    // endpoint lookup and nothing else. Compare with the passing sibling test
    // above: same fixture shape, one delivery row — here, none.
    const poisoned = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "select") {
          return () => {
            throw new Error("forced emit failure");
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof db;

    const result = await softDeleteContact({ db: poisoned, userId });

    // The MUTATION is untouched: it returned, it reported, and it committed.
    expect(result.deleted).toBe(true);
    expect(result.id).toBe(contact.id);
    expect(result.linkUnlinks).toHaveLength(1);
    expect(
      await getLiveLink({ db, provider, providerUserId: pair }),
    ).toBeNull();
    const [row] = await db
      .select({ deletedAt: contacts.deletedAt })
      .from(contacts)
      .where(eq(contacts.id, contact.id));
    expect(row?.deletedAt).not.toBeNull();

    await new Promise((r) => setTimeout(r, SETTLE_MS));
    expect(await deliveriesFor(provider)).toHaveLength(0);
  });
});
