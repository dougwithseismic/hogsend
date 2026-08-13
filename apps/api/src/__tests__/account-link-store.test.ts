import { afterAll, describe, expect, it, vi } from "vitest";

// Same real test DB the engine singletons + the route container read.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, createDatabase, linkedAccounts, schema } = await import(
  "@hogsend/db"
);
const { and, eq, isNull, like, sql } = await import("drizzle-orm");
const { drizzle } = await import("drizzle-orm/postgres-js");
const { PgDialect } = await import("drizzle-orm/pg-core");
const engine = await import("@hogsend/engine");
const {
  AccountLinkVersionRaceError,
  getLiveLink,
  linkAccount,
  listLinkHistory,
  listLiveLinksForContact,
  unlinkAccount,
  unlinkAccountInTx,
} = engine;
// The lock mechanics come from the `/testing` subpath, not the main barrel:
// they are internal to the store and deliberately not part of the engine's
// committed public API.
const { lockPairs, pairLockKey } = await import("@hogsend/engine/testing");

const { db, client } = createDatabase({
  url: process.env.DATABASE_URL as string,
});
type Db = typeof db;

// PRD 03 — every row this suite creates carries this per-run prefix, and
// `afterAll` deletes exactly this namespace (resolve-policy-trusted-kinds
// idiom). Row assertions are always scoped to the namespace, never a
// whole-table count.
const RUN = `alstore-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

let seq = 0;
const uid = (label: string) => `${RUN}-${label}-${seq++}`;
const prov = (label: string) => `${RUN}-${label}`;

async function makeContact(
  fields: {
    externalId?: string | null;
    anonymousId?: string | null;
    email?: string | null;
  } = {},
): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values({
      externalId:
        fields.externalId === undefined ? uid("ext") : fields.externalId,
      anonymousId: fields.anonymousId ?? null,
      email: fields.email ?? null,
    })
    .returning({ id: contacts.id });
  if (!row) throw new Error("contact insert failed");
  return row.id;
}

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

/** Walk `err.cause` for the postgres error code/constraint (drizzle wraps). */
function pgOf(err: unknown): { code?: string; constraint?: string } {
  let cur: unknown = err;
  for (let d = 0; d < 10 && cur && typeof cur === "object"; d++) {
    const c = cur as {
      code?: unknown;
      constraint_name?: unknown;
      cause?: unknown;
    };
    if (typeof c.code === "string") {
      return {
        code: c.code,
        constraint:
          typeof c.constraint_name === "string" ? c.constraint_name : undefined,
      };
    }
    cur = c.cause;
  }
  return {};
}

/** A synthetic drizzle-wrapped postgres error: the code lives on the CAUSE. */
function syntheticPgError(code: string, constraint?: string): Error {
  const cause = Object.assign(new Error(`synthetic ${code}`), {
    code,
    constraint_name: constraint,
  });
  return Object.assign(new Error("query failed"), { cause });
}

/**
 * Wrap the db so the first `times` transaction attempts fail with `error()`
 * (optionally running `beforeAttempt` ahead of each REAL attempt). Everything
 * else passes through. Drives the T5 retry paths deterministically.
 */
function failingTransactions(
  realDb: Db,
  opts: {
    times: number;
    error: () => unknown;
    beforeReal?: () => Promise<void>;
  },
): { db: Db; attempts: () => number } {
  let attempts = 0;
  const proxied = new Proxy(realDb as object, {
    get(target, propKey, receiver) {
      if (propKey === "transaction") {
        return async (...args: unknown[]) => {
          attempts++;
          if (attempts <= opts.times) throw opts.error();
          await opts.beforeReal?.();
          return (
            target as unknown as {
              transaction: (...a: unknown[]) => Promise<unknown>;
            }
          ).transaction(...args);
        };
      }
      const value = Reflect.get(target, propKey, receiver);
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as unknown as Db;
  return { db: proxied, attempts: () => attempts };
}

/** A second drizzle handle over the SAME pool that logs every statement. */
function loggedDb(): { db: Db; queries: Array<{ q: string; p: unknown[] }> } {
  const queries: Array<{ q: string; p: unknown[] }> = [];
  const logged = drizzle(client, {
    schema,
    logger: {
      logQuery(q: string, p: unknown[]) {
        queries.push({ q, p });
      },
    },
  }) as unknown as Db;
  return { db: logged, queries };
}

afterAll(async () => {
  await db
    .delete(linkedAccounts)
    .where(like(linkedAccounts.provider, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.anonymousId, `${RUN}-%`));
  await client.end();
});

// ---------------------------------------------------------------------------
// T1 — projection
// ---------------------------------------------------------------------------

describe("account link store — projection (T1)", () => {
  it("toLinkedAccountRecord never surfaces the sealed blob", async () => {
    const provider = prov("t1");
    const contactId = await makeContact();
    const providerUserId = uid("u");
    const plaintext = `${RUN}-super-secret-access-token`;

    const result = await linkAccount(
      linkInput({
        contactId,
        provider,
        identity: {
          providerUserId,
          tokens: { accessToken: plaintext },
        },
        storeTokens: true,
      }),
    );
    expect(result.status).toBe("linked");

    const records = [
      await getLiveLink({ db, provider, providerUserId }),
      ...(await listLiveLinksForContact({ db, contactId })),
      ...(await listLinkHistory({ db, provider, providerUserId })),
    ];
    expect(records.length).toBeGreaterThanOrEqual(3);
    for (const rec of records) {
      expect(rec).not.toBeNull();
      expect(rec).not.toHaveProperty("tokens");
      expect(rec?.hasTokens).toBe(true);
      expect(JSON.stringify(rec)).not.toContain(plaintext);
    }
    // The mutation result's row goes through the same one projection.
    if (result.status === "linked") {
      expect(result.row).not.toHaveProperty("tokens");
      expect(JSON.stringify(result)).not.toContain(plaintext);
    }
  });
});

// ---------------------------------------------------------------------------
// T2 — the advisory lock
// ---------------------------------------------------------------------------

describe("account link store — advisory lock (T2)", () => {
  it("acquires locks in sorted order", async () => {
    const executed: unknown[] = [];
    const fakeTx = {
      execute: vi.fn(async (query: unknown) => {
        executed.push(query);
        return [];
      }),
    } as unknown as Parameters<typeof lockPairs>[0];

    // Reversed + duplicated input; the lock must come out sorted and deduped.
    await lockPairs(fakeTx, [
      pairLockKey("steam", "zzz"),
      pairLockKey("steam", "aaa"),
      pairLockKey("steam", "zzz"),
    ]);

    const dialect = new PgDialect();
    const params = executed.map(
      // biome-ignore lint/suspicious/noExplicitAny: test-only SQL introspection
      (q) => dialect.sqlToQuery(q as any).params[0],
    );
    expect(params).toEqual([
      pairLockKey("steam", "aaa"),
      pairLockKey("steam", "zzz"),
    ]);
    for (const q of executed) {
      // biome-ignore lint/suspicious/noExplicitAny: test-only SQL introspection
      expect(dialect.sqlToQuery(q as any).sql).toContain(
        "pg_advisory_xact_lock(hashtext(",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// T3 — versioning + policy branches
// ---------------------------------------------------------------------------

describe("account link store — versioning and policy (T3)", () => {
  it("first link gets version 1", async () => {
    const provider = prov("t3-first");
    const contactId = await makeContact();
    const providerUserId = uid("u");

    const result = await linkAccount(
      linkInput({ contactId, provider, identity: { providerUserId } }),
    );
    expect(result.status).toBe("linked");
    if (result.status !== "linked") return;
    expect(result.relink).toBe(false);
    expect(result.version).toBe("1");
    expect(typeof result.version).toBe("string");
    expect(result.row.version).toBe("1");
    expect(result.owner.contactId).toBe(contactId);
  });

  it("relink burns two versions and the unlink version is lower than the link version", async () => {
    const provider = prov("t3-relink");
    const c1 = await makeContact();
    const c2 = await makeContact();
    const providerUserId = uid("u");

    await linkAccount(
      linkInput({ contactId: c1, provider, identity: { providerUserId } }),
    );
    const result = await linkAccount(
      linkInput({
        contactId: c2,
        provider,
        identity: { providerUserId },
        allowDisplaceLiveOwner: true,
      }),
    );
    expect(result.status).toBe("relinked");
    if (result.status !== "relinked") return;
    expect(result.relink).toBe(true);
    expect(result.previous.contactId).toBe(c1);
    // Load-bearing ordering: the displaced row's soft-unlink takes N+1 and
    // the new row N+2, so a consumer receiving the unlink LATE discards it
    // via `incoming.version > stored.version`.
    expect(result.previous.version).toBe("2");
    expect(result.version).toBe("3");
    expect(BigInt(result.previous.version) < BigInt(result.version)).toBe(true);

    const history = await listLinkHistory({ db, provider, providerUserId });
    expect(history).toHaveLength(2);
    const unlinked = history.find((r) => r.unlinkedAt !== null);
    expect(unlinked?.version).toBe("2");
    expect(unlinked?.unlinkReason).toBe("relinked");
    const live = await getLiveLink({ db, provider, providerUserId });
    expect(live?.contactId).toBe(c2);
    expect(live?.version).toBe("3");
  });

  it("same-owner call refreshes display fields without bumping the version", async () => {
    const provider = prov("t3-refresh");
    const contactId = await makeContact();
    const providerUserId = uid("u");

    await linkAccount(
      linkInput({
        contactId,
        provider,
        identity: { providerUserId, username: "old-name" },
      }),
    );
    const result = await linkAccount(
      linkInput({
        contactId,
        provider,
        identity: {
          providerUserId,
          username: "new-name",
          avatarUrl: "https://example.com/a.png",
        },
      }),
    );
    expect(result.status).toBe("unchanged");
    if (result.status !== "unchanged") return;
    expect(result.version).toBe("1");
    expect(result.row.username).toBe("new-name");
    expect(result.row.avatarUrl).toBe("https://example.com/a.png");

    // No second row, no burned version.
    const history = await listLinkHistory({ db, provider, providerUserId });
    expect(history).toHaveLength(1);
    expect(history[0]?.version).toBe("1");
  });

  it("import cannot displace a live owner", async () => {
    const provider = prov("t3-import");
    const c1 = await makeContact();
    const c2 = await makeContact();
    const providerUserId = uid("u");

    await linkAccount(
      linkInput({ contactId: c1, provider, identity: { providerUserId } }),
    );
    // The import path passes allowDisplaceLiveOwner: false and is therefore
    // structurally insert-only (DECISIONS §6.2).
    const result = await linkAccount(
      linkInput({
        contactId: c2,
        provider,
        identity: { providerUserId },
        method: "import",
        allowDisplaceLiveOwner: false,
      }),
    );
    expect(result).toEqual({
      status: "rejected",
      reason: "live_owner_conflict",
      currentOwnerContactId: c1,
    });
    const live = await getLiveLink({ db, provider, providerUserId });
    expect(live?.contactId).toBe(c1);
    expect(live?.version).toBe("1");
  });

  it("oauth callback can displace a live owner", async () => {
    const provider = prov("t3-oauth");
    const c1 = await makeContact();
    const c2 = await makeContact();
    const providerUserId = uid("u");

    await linkAccount(
      linkInput({ contactId: c1, provider, identity: { providerUserId } }),
    );
    const result = await linkAccount(
      linkInput({
        contactId: c2,
        provider,
        identity: { providerUserId },
        allowDisplaceLiveOwner: true,
      }),
    );
    expect(result.status).toBe("relinked");
    const live = await getLiveLink({ db, provider, providerUserId });
    expect(live?.contactId).toBe(c2);
  });

  it("stores a sealed blob that is not the plaintext token", async () => {
    const provider = prov("t3-seal");
    const contactId = await makeContact();
    const providerUserId = uid("u");
    const plaintext = `${RUN}-access-token-plaintext`;

    await linkAccount(
      linkInput({
        contactId,
        provider,
        identity: {
          providerUserId,
          tokens: { accessToken: plaintext, refreshToken: `${RUN}-refresh` },
        },
        storeTokens: true,
      }),
    );
    const [row] = await db
      .select({ tokens: linkedAccounts.tokens })
      .from(linkedAccounts)
      .where(
        and(
          eq(linkedAccounts.provider, provider),
          eq(linkedAccounts.providerUserId, providerUserId),
        ),
      );
    expect(row?.tokens).toBeTruthy();
    expect(row?.tokens).not.toContain(plaintext);
    expect(row?.tokens).not.toContain(`${RUN}-refresh`);
  });

  it("drops tokens when storeTokens is false", async () => {
    const provider = prov("t3-drop");
    const contactId = await makeContact();
    const providerUserId = uid("u");

    const result = await linkAccount(
      linkInput({
        contactId,
        provider,
        identity: {
          providerUserId,
          tokens: { accessToken: `${RUN}-should-never-be-stored` },
        },
        storeTokens: false,
      }),
    );
    expect(result.status).toBe("linked");
    if (result.status === "linked") expect(result.row.hasTokens).toBe(false);
    const [row] = await db
      .select({ tokens: linkedAccounts.tokens })
      .from(linkedAccounts)
      .where(
        and(
          eq(linkedAccounts.provider, provider),
          eq(linkedAccounts.providerUserId, providerUserId),
        ),
      );
    expect(row?.tokens).toBeNull();
  });

  it("a version above Number.MAX_SAFE_INTEGER round-trips as a string", async () => {
    const provider = prov("t3-big");
    const seedContact = await makeContact();
    const contactId = await makeContact();
    const providerUserId = uid("u");

    // Seed the pair at 2^53 + 1 — any Number()/parseInt on the path rounds
    // 9007199254740993 to ...992 and the +1 to ...992/994 ambiguity below
    // fails the strict equality.
    await db.insert(linkedAccounts).values({
      contactId: seedContact,
      provider,
      providerUserId,
      method: "oauth",
      singleton: false,
      version: 9007199254740993n,
      unlinkedAt: new Date(),
      unlinkReason: "player",
    });

    const result = await linkAccount(
      linkInput({ contactId, provider, identity: { providerUserId } }),
    );
    expect(result.status).toBe("linked");
    if (result.status !== "linked") return;
    expect(typeof result.version).toBe("string");
    expect(result.version).toBe("9007199254740994");

    // The stored column matches when read back AS TEXT.
    const rows = (await db.execute(sql`
      SELECT version::text AS v FROM linked_accounts
      WHERE provider = ${provider} AND provider_user_id = ${providerUserId}
        AND unlinked_at IS NULL
    `)) as unknown as Array<{ v: string }>;
    expect(rows[0]?.v).toBe("9007199254740994");

    // 2^53+2 is an EVEN float64-representable value, so ...994 alone cannot
    // catch a Number() in the increment path. The next mutation lands on the
    // ODD ...995, which float64 CANNOT represent (Number("9007199254740995")
    // === 9007199254740996) — this leg is what makes the test non-vacuous.
    const unlinked = await unlinkAccount({
      db,
      provider,
      providerUserId,
      reason: "api",
    });
    expect(unlinked.status).toBe("unlinked");
    if (unlinked.status === "unlinked") {
      expect(unlinked.version).toBe("9007199254740995");
    }

    // And the seeded ODD version must survive the read-side projection
    // verbatim (String(row.version), never Number()).
    const history = await listLinkHistory({ db, provider, providerUserId });
    expect(history.map((r) => r.version)).toContain("9007199254740993");
  });

  it("returns owner.userId as the contact key and owner.email as the contact's own email", async () => {
    const provider = prov("t3-owner");
    const anonymousId = uid("anon");
    const contactEmail = `${RUN}-me@example.com`;
    const providerEmail = `${RUN}-provider-reported@example.com`;
    // externalId is NULL, anonymousId set → contactKey() must fall through to
    // the anonymous id, never null, never the (absent) external id.
    const contactId = await makeContact({
      externalId: null,
      anonymousId,
      email: contactEmail,
    });

    const result = await linkAccount(
      linkInput({
        contactId,
        provider,
        identity: { providerUserId: uid("u"), verifiedEmail: providerEmail },
      }),
    );
    expect(result.status).toBe("linked");
    if (result.status !== "linked") return;
    expect(result.owner.userId).toBe(anonymousId);
    // The CONTACT's email, never identity.verifiedEmail (DECISIONS §6.4 — the
    // provider-reported address in the payload is the grafting vector).
    expect(result.owner.email).toBe(contactEmail);
    expect(result.owner.email).not.toBe(providerEmail);
  });
});

// ---------------------------------------------------------------------------
// T3b — unlinkAccountInTx
// ---------------------------------------------------------------------------

describe("account link store — unlinkAccountInTx (T3b)", () => {
  it("unlinkAccountInTx bumps the version inside a caller's transaction", async () => {
    const provider = prov("t3b-bump");
    const contactId = await makeContact();
    const providerUserId = uid("u");
    const linked = await linkAccount(
      linkInput({ contactId, provider, identity: { providerUserId } }),
    );
    if (linked.status !== "linked") throw new Error("seed failed");

    const result = await db.transaction((tx) =>
      unlinkAccountInTx(tx, {
        rowId: linked.row.id,
        provider,
        providerUserId,
        reason: "api",
      }),
    );
    expect(result.status).toBe("unlinked");
    if (result.status !== "unlinked") return;
    expect(result.version).toBe("2");
    expect(result.owner.contactId).toBe(contactId);

    const live = await getLiveLink({ db, provider, providerUserId });
    expect(live).toBeNull();
    const [row] = await listLinkHistory({ db, provider, providerUserId });
    expect(row?.version).toBe("2");
    expect(row?.unlinkReason).toBe("api");
  });

  it("unlinkAccountInTx rolls back with its caller", async () => {
    const provider = prov("t3b-rollback");
    const contactId = await makeContact();
    const providerUserId = uid("u");
    const linked = await linkAccount(
      linkInput({ contactId, provider, identity: { providerUserId } }),
    );
    if (linked.status !== "linked") throw new Error("seed failed");

    await expect(
      db.transaction(async (tx) => {
        const r = await unlinkAccountInTx(tx, {
          rowId: linked.row.id,
          provider,
          providerUserId,
          reason: "api",
        });
        expect(r.status).toBe("unlinked");
        throw new Error("caller rollback");
      }),
    ).rejects.toThrow("caller rollback");

    // No trace: the row is still live at version 1.
    const live = await getLiveLink({ db, provider, providerUserId });
    expect(live?.contactId).toBe(contactId);
    expect(live?.version).toBe("1");
    expect(live?.unlinkedAt).toBeNull();
  });

  it("unlinkAccountInTx invokes no hook and opens no transaction of its own", async () => {
    const provider = prov("t3b-nohook");
    const contactId = await makeContact();
    const providerUserId = uid("u");
    // The signature has NO hooks channel at all — this spy existing proves the
    // caller cannot even hand one over; the proxy proves no nested tx opens.
    const afterUnlink = vi.fn();
    const linked = await linkAccount(
      linkInput({ contactId, provider, identity: { providerUserId } }),
    );
    if (linked.status !== "linked") throw new Error("seed failed");

    const accessed: Array<string | symbol> = [];
    await db.transaction(async (tx) => {
      const watched = new Proxy(tx as object, {
        get(target, propKey, receiver) {
          accessed.push(propKey);
          const value = Reflect.get(target, propKey, receiver);
          return typeof value === "function"
            ? (value as (...a: unknown[]) => unknown).bind(target)
            : value;
        },
      }) as typeof tx;
      await unlinkAccountInTx(watched, {
        rowId: linked.row.id,
        provider,
        providerUserId,
        reason: "player",
      });
    });

    expect(accessed).not.toContain("transaction");
    expect(afterUnlink).not.toHaveBeenCalled();
  });

  it("unlinkAccountInTx returns the version as a string", async () => {
    const provider = prov("t3b-string");
    const contactId = await makeContact();
    const providerUserId = uid("u");
    const linked = await linkAccount(
      linkInput({ contactId, provider, identity: { providerUserId } }),
    );
    if (linked.status !== "linked") throw new Error("seed failed");

    const result = await db.transaction((tx) =>
      unlinkAccountInTx(tx, {
        rowId: linked.row.id,
        provider,
        providerUserId,
        reason: "api",
      }),
    );
    if (result.status !== "unlinked") throw new Error("unlink failed");
    expect(typeof result.version).toBe("string");
    expect(result.version).toBe("2");
  });
});

// ---------------------------------------------------------------------------
// T4 — multiple:false and onConflict
// ---------------------------------------------------------------------------

describe("account link store — singleton policy (T4)", () => {
  it("rejects a second link under multiple:false with onConflict reject", async () => {
    const provider = prov("t4-reject");
    const contactId = await makeContact();
    const uidA = uid("a");
    const uidB = uid("b");

    const first = await linkAccount(
      linkInput({
        contactId,
        provider,
        identity: { providerUserId: uidA },
        multiple: false,
        onConflict: "reject",
      }),
    );
    expect(first.status).toBe("linked");
    if (first.status === "linked") expect(first.row.singleton).toBe(true);

    const second = await linkAccount(
      linkInput({
        contactId,
        provider,
        identity: { providerUserId: uidB },
        multiple: false,
        onConflict: "reject",
      }),
    );
    expect(second).toEqual({
      status: "rejected",
      reason: "singleton_conflict",
    });
    // Nothing mutated: no row for pair B, pair A untouched.
    expect(
      await listLinkHistory({ db, provider, providerUserId: uidB }),
    ).toEqual([]);
    const liveA = await getLiveLink({ db, provider, providerUserId: uidA });
    expect(liveA?.version).toBe("1");
  });

  it("replaces the existing link under multiple:false with onConflict replace", async () => {
    const provider = prov("t4-replace");
    const contactId = await makeContact();
    const uidA = uid("a");
    const uidB = uid("b");

    await linkAccount(
      linkInput({
        contactId,
        provider,
        identity: { providerUserId: uidA },
        multiple: false,
        onConflict: "replace",
      }),
    );
    const result = await linkAccount(
      linkInput({
        contactId,
        provider,
        identity: { providerUserId: uidB },
        multiple: false,
        onConflict: "replace",
      }),
    );
    expect(result.status).toBe("linked");
    if (result.status !== "linked") return;
    expect(result.replacedSingleton?.providerUserId).toBe(uidA);
    expect(result.replacedSingleton?.contactId).toBe(contactId);

    const oldRow = await getLiveLink({ db, provider, providerUserId: uidA });
    expect(oldRow).toBeNull();
    const [historyA] = await listLinkHistory({
      db,
      provider,
      providerUserId: uidA,
    });
    expect(historyA?.unlinkReason).toBe("relinked");
    const liveLinks = await listLiveLinksForContact({ db, contactId });
    expect(liveLinks.map((l) => l.providerUserId)).toEqual([uidB]);
  });

  it("locks both pairs before the probe under multiple:false", async () => {
    const provider = prov("t4-lockorder");
    const contactId = await makeContact();
    // Chosen so the INPUT order (target first, pre-read second) is the
    // REVERSE of sorted order — the sort must flip them.
    const uidExisting = `${RUN}-aaa-existing`;
    const uidTarget = `${RUN}-zzz-target`;

    await linkAccount(
      linkInput({
        contactId,
        provider,
        identity: { providerUserId: uidExisting },
        multiple: false,
        onConflict: "replace",
      }),
    );

    const { db: logged, queries } = loggedDb();
    const result = await linkAccount(
      linkInput({
        db: logged,
        contactId,
        provider,
        identity: { providerUserId: uidTarget },
        multiple: false,
        onConflict: "replace",
      }),
    );
    expect(result.status).toBe("linked");

    const lockIdx = queries
      .map((entry, i) => ({ entry, i }))
      .filter(({ entry }) => entry.q.includes("pg_advisory_xact_lock"));
    expect(lockIdx).toHaveLength(2);
    // Sorted key order despite reversed input order.
    expect(lockIdx[0]?.entry.p[0]).toBe(pairLockKey(provider, uidExisting));
    expect(lockIdx[1]?.entry.p[0]).toBe(pairLockKey(provider, uidTarget));

    // The two locks are the transaction's FIRST statements: the only
    // linked_accounts statement allowed BEFORE them is the out-of-transaction
    // singleton pre-read (step 0).
    const firstLockAt = lockIdx[0]?.i ?? -1;
    const linkedAccountStmtsBefore = queries
      .slice(0, firstLockAt)
      .filter(({ q }) => q.includes("linked_accounts"));
    expect(linkedAccountStmtsBefore).toHaveLength(1);
    expect(linkedAccountStmtsBefore[0]?.q).toContain("singleton");
    // Locks are consecutive; the live-owner probe comes strictly after.
    expect(lockIdx[1]?.i).toBe(firstLockAt + 1);
  });

  it("the replaced row gets its own pair's next version, not the new pair's", async () => {
    const provider = prov("t4-ownversion");
    const contactId = await makeContact();
    const uidA = uid("a");
    const uidB = uid("b");

    // Give pair A a longer history: link (1) → unlink (2) → link (3).
    await linkAccount(
      linkInput({
        contactId,
        provider,
        identity: { providerUserId: uidA },
        multiple: false,
        onConflict: "replace",
      }),
    );
    await unlinkAccount({ db, provider, providerUserId: uidA, reason: "api" });
    await linkAccount(
      linkInput({
        contactId,
        provider,
        identity: { providerUserId: uidA },
        multiple: false,
        onConflict: "replace",
      }),
    );

    const result = await linkAccount(
      linkInput({
        contactId,
        provider,
        identity: { providerUserId: uidB },
        multiple: false,
        onConflict: "replace",
      }),
    );
    expect(result.status).toBe("linked");
    if (result.status !== "linked") return;
    // Pair A's own sequence continues at 4; pair B starts its own at 1.
    expect(result.replacedSingleton?.version).toBe("4");
    expect(result.version).toBe("1");
  });

  it("multiple:true allows many live links for one contact", async () => {
    const provider = prov("t4-multi");
    const contactId = await makeContact();
    const uidA = uid("a");
    const uidB = uid("b");

    const r1 = await linkAccount(
      linkInput({ contactId, provider, identity: { providerUserId: uidA } }),
    );
    const r2 = await linkAccount(
      linkInput({ contactId, provider, identity: { providerUserId: uidB } }),
    );
    expect(r1.status).toBe("linked");
    expect(r2.status).toBe("linked");
    const live = await listLiveLinksForContact({ db, contactId });
    expect(live).toHaveLength(2);
    for (const l of live) expect(l.singleton).toBe(false);
  });

  it("inserting a duplicate singleton directly violates the index", async () => {
    const provider = prov("t4-index");
    const contactId = await makeContact();

    await db.insert(linkedAccounts).values({
      contactId,
      provider,
      providerUserId: uid("a"),
      method: "oauth",
      singleton: true,
      version: 1n,
    });
    // The branch logic is NOT the enforcement — the partial unique index
    // `linked_accounts_contact_provider_singleton_idx` is. Drive the DB
    // directly to prove the constraint backs the guard.
    const err = await db
      .insert(linkedAccounts)
      .values({
        contactId,
        provider,
        providerUserId: uid("b"),
        method: "oauth",
        singleton: true,
        version: 1n,
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).not.toBeNull();
    const pg = pgOf(err);
    expect(pg.code).toBe("23505");
    expect(pg.constraint).toBe(
      "linked_accounts_contact_provider_singleton_idx",
    );
  });
});

// ---------------------------------------------------------------------------
// T5 — retry
// ---------------------------------------------------------------------------

describe("account link store — retry (T5)", () => {
  it("retries once and succeeds when the version index conflicts", async () => {
    const provider = prov("t5-retry");
    const contactId = await makeContact();
    const providerUserId = uid("u");
    const wrapped = failingTransactions(db, {
      times: 1,
      error: () =>
        syntheticPgError("23505", "linked_accounts_provider_uid_version_idx"),
    });

    const result = await linkAccount(
      linkInput({
        db: wrapped.db,
        contactId,
        provider,
        identity: { providerUserId },
      }),
    );
    expect(result.status).toBe("linked");
    expect(wrapped.attempts()).toBe(2);
    const history = await listLinkHistory({ db, provider, providerUserId });
    expect(history).toHaveLength(1);
  });

  it("does not retry a live-index conflict", async () => {
    const provider = prov("t5-live");
    const contactId = await makeContact();
    const wrapped = failingTransactions(db, {
      times: Number.POSITIVE_INFINITY,
      error: () =>
        syntheticPgError("23505", "linked_accounts_provider_uid_live_idx"),
    });

    const err = await linkAccount(
      linkInput({
        db: wrapped.db,
        contactId,
        provider,
        identity: { providerUserId: uid("u") },
      }),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    expect(err).not.toBeInstanceOf(AccountLinkVersionRaceError);
    expect(pgOf(err).constraint).toBe("linked_accounts_provider_uid_live_idx");
    // Rethrown on the FIRST failure — retrying a live-index conflict loops.
    expect(wrapped.attempts()).toBe(1);
  });

  it("throws AccountLinkVersionRaceError after three failures", async () => {
    const provider = prov("t5-race");
    const contactId = await makeContact();
    const wrapped = failingTransactions(db, {
      times: Number.POSITIVE_INFINITY,
      error: () =>
        syntheticPgError("23505", "linked_accounts_provider_uid_version_idx"),
    });

    await expect(
      linkAccount(
        linkInput({
          db: wrapped.db,
          contactId,
          provider,
          identity: { providerUserId: uid("u") },
        }),
      ),
    ).rejects.toBeInstanceOf(AccountLinkVersionRaceError);
    expect(wrapped.attempts()).toBe(3);
  });

  it("retries a 40P01", async () => {
    const provider = prov("t5-deadlock");
    const contactId = await makeContact();
    const providerUserId = uid("u");
    const wrapped = failingTransactions(db, {
      times: 1,
      error: () =>
        Object.assign(new Error("deadlock detected"), { code: "40P01" }),
    });

    const result = await linkAccount(
      linkInput({
        db: wrapped.db,
        contactId,
        provider,
        identity: { providerUserId },
      }),
    );
    expect(result.status).toBe("linked");
    expect(wrapped.attempts()).toBe(2);
    const live = await getLiveLink({ db, provider, providerUserId });
    expect(live?.version).toBe("1");
  });

  // 40001 gets its own case rather than riding on the 40P01 one above: the
  // retryable set is a two-code OR (`pg.code === "40P01" || pg.code ===
  // "40001"`), so a test for only one half leaves deleting the other half a
  // silent no-op. PRD 03's Done-when names both.
  it("retries a 40001", async () => {
    const provider = prov("t5-serialization");
    const contactId = await makeContact();
    const providerUserId = uid("u");
    const wrapped = failingTransactions(db, {
      times: 1,
      error: () =>
        Object.assign(new Error("could not serialize access"), {
          code: "40001",
        }),
    });

    const result = await linkAccount(
      linkInput({
        db: wrapped.db,
        contactId,
        provider,
        identity: { providerUserId },
      }),
    );
    expect(result.status).toBe("linked");
    expect(wrapped.attempts()).toBe(2);
    const live = await getLiveLink({ db, provider, providerUserId });
    expect(live?.version).toBe("1");
  });

  it("retries a stale lock set and locks the new pair from the start", async () => {
    const provider = prov("t5-stale");
    const contactId = await makeContact();
    const uidOld = `${RUN}-stale-old`;
    const uidNew = `${RUN}-stale-new`;
    const uidTarget = `${RUN}-stale-target`;

    // The contact's live singleton is pair OLD when the pre-read runs...
    await db.insert(linkedAccounts).values({
      contactId,
      provider,
      providerUserId: uidOld,
      method: "oauth",
      singleton: true,
      version: 1n,
    });

    // ...but by the time the transaction opens, a concurrent mutation swapped
    // it to pair NEW. The first attempt holds locks for {target, OLD}, finds
    // NEW, must NOT lock it mid-transaction — it aborts and the retry re-runs
    // the pre-read.
    const { db: logged, queries } = loggedDb();
    let swapped = false;
    let attempts = 0;
    const racing = new Proxy(logged as object, {
      get(target, propKey, receiver) {
        if (propKey === "transaction") {
          return async (...args: unknown[]) => {
            attempts++;
            queries.push({ q: `-- ATTEMPT ${attempts}`, p: [] });
            if (!swapped) {
              swapped = true;
              const now = new Date();
              await db
                .update(linkedAccounts)
                .set({ unlinkedAt: now, unlinkReason: "relinked", version: 2n })
                .where(
                  and(
                    eq(linkedAccounts.provider, provider),
                    eq(linkedAccounts.providerUserId, uidOld),
                    isNull(linkedAccounts.unlinkedAt),
                  ),
                );
              await db.insert(linkedAccounts).values({
                contactId,
                provider,
                providerUserId: uidNew,
                method: "oauth",
                singleton: true,
                version: 1n,
              });
            }
            return (
              target as unknown as {
                transaction: (...a: unknown[]) => Promise<unknown>;
              }
            ).transaction(...args);
          };
        }
        const value = Reflect.get(target, propKey, receiver);
        return typeof value === "function"
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as unknown as Db;

    const result = await linkAccount(
      linkInput({
        db: racing,
        contactId,
        provider,
        identity: { providerUserId: uidTarget },
        multiple: false,
        onConflict: "replace",
      }),
    );
    expect(result.status).toBe("linked");
    if (result.status !== "linked") return;
    expect(result.replacedSingleton?.providerUserId).toBe(uidNew);
    expect(attempts).toBe(2);

    // The SECOND attempt locked the NEW pair from its first statement — it
    // never grabbed a lock mid-transaction on attempt one.
    const attempt2At = queries.findIndex((e) => e.q === "-- ATTEMPT 2");
    expect(attempt2At).toBeGreaterThan(-1);
    const attempt2Locks = queries
      .slice(attempt2At)
      .filter((e) => e.q.includes("pg_advisory_xact_lock"));
    expect(attempt2Locks.map((e) => e.p[0])).toEqual(
      [pairLockKey(provider, uidNew), pairLockKey(provider, uidTarget)].sort(),
    );
    const attempt1Locks = queries
      .slice(0, attempt2At)
      .filter((e) => e.q.includes("pg_advisory_xact_lock"));
    // Attempt one locked {target, OLD} only — never NEW.
    expect(attempt1Locks.map((e) => e.p[0])).not.toContain(
      pairLockKey(provider, uidNew),
    );

    const liveNew = await getLiveLink({ db, provider, providerUserId: uidNew });
    expect(liveNew).toBeNull();
    const liveTarget = await getLiveLink({
      db,
      provider,
      providerUserId: uidTarget,
    });
    expect(liveTarget?.contactId).toBe(contactId);
  });
});

// ---------------------------------------------------------------------------
// T6 — post-commit hooks (this module is their ONLY invoker)
// ---------------------------------------------------------------------------

describe("account link store — post-commit hooks (T6)", () => {
  it("afterLink runs after commit and sees its own row", async () => {
    const provider = prov("t6-commit");
    const contactId = await makeContact();
    const providerUserId = uid("u");
    let seen: string | null | undefined;

    const result = await linkAccount(
      linkInput({
        contactId,
        provider,
        identity: { providerUserId },
        hooks: {
          afterLink: async (ctx) => {
            // A hook reading the pull plane must see its own committed write.
            const live = await getLiveLink({
              db,
              provider: ctx.provider,
              providerUserId: ctx.identity.providerUserId,
            });
            seen = live?.version;
          },
        },
      }),
    );
    expect(result.status).toBe("linked");
    expect(seen).toBe("1");
  });

  it("afterLink throwing does not fail the link", async () => {
    const provider = prov("t6-throw");
    const contactId = await makeContact();
    const providerUserId = uid("u");

    const result = await linkAccount(
      linkInput({
        contactId,
        provider,
        identity: { providerUserId },
        hooks: {
          afterLink: () => {
            throw new Error("customer hook exploded");
          },
        },
      }),
    );
    expect(result.status).toBe("linked");
    const live = await getLiveLink({ db, provider, providerUserId });
    expect(live?.version).toBe("1");
  });

  it("afterLink exceeding 5s does not fail the link", async () => {
    const provider = prov("t6-timeout");
    const contactId = await makeContact();
    const providerUserId = uid("u");
    const startedAt = Date.now();

    const result = await linkAccount(
      linkInput({
        contactId,
        provider,
        identity: { providerUserId },
        hooks: {
          // Never settles — only the ACCOUNT_LINK_HOOK_TIMEOUT_MS race bound
          // can unblock the mutation.
          afterLink: () => new Promise<void>(() => {}),
        },
      }),
    );
    expect(result.status).toBe("linked");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4_900);
  }, 20_000);

  it("relink invokes afterUnlink before afterLink", async () => {
    const provider = prov("t6-order");
    const c1 = await makeContact();
    const c2 = await makeContact();
    const providerUserId = uid("u");
    const order: string[] = [];

    await linkAccount(
      linkInput({ contactId: c1, provider, identity: { providerUserId } }),
    );
    const result = await linkAccount(
      linkInput({
        contactId: c2,
        provider,
        identity: { providerUserId },
        allowDisplaceLiveOwner: true,
        hooks: {
          afterLink: (ctx) => {
            order.push(`afterLink:${ctx.version}`);
          },
          afterUnlink: (ctx) => {
            order.push(`afterUnlink:${ctx.version}`);
          },
        },
      }),
    );
    expect(result.status).toBe("relinked");
    // Mirrors the outbound event order (DECISIONS §5): the displaced row's
    // unlink (N+1) strictly before the new row's link (N+2).
    expect(order).toEqual(["afterUnlink:2", "afterLink:3"]);
  });

  it("the store never invokes beforeLink", async () => {
    const provider = prov("t6-noveto");
    const c1 = await makeContact();
    const c2 = await makeContact();
    const providerUserId = uid("u");
    const beforeLink = vi.fn();
    const hooks = { beforeLink };

    await linkAccount(
      linkInput({
        contactId: c1,
        provider,
        identity: { providerUserId },
        hooks,
      }),
    );
    await linkAccount(
      linkInput({
        contactId: c2,
        provider,
        identity: { providerUserId },
        allowDisplaceLiveOwner: true,
        hooks,
      }),
    );
    await unlinkAccount({ db, provider, providerUserId, reason: "api", hooks });
    // The veto is PRD 07's, pre-write. The store accepts a decision, never
    // re-runs it.
    expect(beforeLink).not.toHaveBeenCalled();
  });

  it("a successful linkAccount invokes afterLink exactly once", async () => {
    const provider = prov("t6-once");
    const contactId = await makeContact();
    const providerUserId = uid("u");
    let calls = 0;

    const result = await linkAccount(
      linkInput({
        contactId,
        provider,
        identity: { providerUserId },
        hooks: {
          afterLink: () => {
            calls++;
          },
        },
      }),
    );
    expect(result.status).toBe("linked");
    // A COUNTING assertion, not toHaveBeenCalled(): "was it called" passes
    // just as happily when the hook fires twice, which is the exact
    // double-invocation bug DECISIONS §15.4 exists to close.
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Guards the mutations above don't cover
// ---------------------------------------------------------------------------

describe("account link store — unlink guards", () => {
  it("unlinkAccount on a pair with no live row returns not_found without consuming a version", async () => {
    const provider = prov("g-notfound");
    const result = await unlinkAccount({
      db,
      provider,
      providerUserId: uid("u"),
      reason: "api",
    });
    expect(result).toEqual({ status: "not_found" });
  });

  it("unlinkAccount with expectContactId naming a non-owner rejects with not_owner", async () => {
    const provider = prov("g-notowner");
    const owner = await makeContact();
    const other = await makeContact();
    const providerUserId = uid("u");
    await linkAccount(
      linkInput({ contactId: owner, provider, identity: { providerUserId } }),
    );

    const result = await unlinkAccount({
      db,
      provider,
      providerUserId,
      reason: "player",
      expectContactId: other,
    });
    expect(result).toEqual({
      status: "rejected",
      reason: "not_owner",
      currentOwnerContactId: owner,
    });
    // Nothing mutated.
    const live = await getLiveLink({ db, provider, providerUserId });
    expect(live?.contactId).toBe(owner);
    expect(live?.version).toBe("1");
  });

  it("a vetoed mutation writes nothing", async () => {
    const provider = prov("g-veto");
    const contactId = await makeContact();
    const providerUserId = uid("u");
    const afterLink = vi.fn();

    const result = await linkAccount(
      linkInput({
        contactId,
        provider,
        identity: { providerUserId },
        vetoed: true,
        hooks: { afterLink },
      }),
    );
    expect(result).toEqual({ status: "rejected", reason: "vetoed" });
    expect(await listLinkHistory({ db, provider, providerUserId })).toEqual([]);
    expect(afterLink).not.toHaveBeenCalled();
  });
});
