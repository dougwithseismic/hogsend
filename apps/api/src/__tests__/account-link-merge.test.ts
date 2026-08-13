import { afterAll, describe, expect, it } from "vitest";

// Same real test DB the engine singletons + the route container read.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contactAliases, contacts, createDatabase, linkedAccounts } =
  await import("@hogsend/db");
const { and, eq, inArray, like, or, sql } = await import("drizzle-orm");
const engine = await import("@hogsend/engine");
const { getLiveLink, linkAccount, listLinkHistory, resolveOrCreateContact } =
  engine;
// ALL_IDENTITY_KINDS is deliberately NOT on the main barrel (it is the
// resolver's internal full-trust grant, not public API) — the guard test
// reaches it through the `/testing` subpath, same as the store's lock
// mechanics.
const { ALL_IDENTITY_KINDS } = await import("@hogsend/engine/testing");

const { db, client } = createDatabase({
  url: process.env.DATABASE_URL as string,
});

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
