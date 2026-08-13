import { afterAll, describe, expect, it } from "vitest";

// Same real test DB the engine singletons + the route container read.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, createDatabase, linkedAccounts } = await import(
  "@hogsend/db"
);
const { and, eq, like } = await import("drizzle-orm");
const engine = await import("@hogsend/engine");
const { getLiveLink, linkAccount, unlinkAccount } = engine;

// PRD 03 T7 — THE REAL RACE. Two INDEPENDENT postgres() pools: every
// `db.transaction()` reserves its own connection, and the two handles
// guarantee the racing mutations never share one. A single connection
// serializes for free and would certify nothing about the advisory lock.
const url = process.env.DATABASE_URL as string;
const poolA = createDatabase({ url });
const poolB = createDatabase({ url });
const dbA = poolA.db;
const dbB = poolB.db;
// Seeding/cleanup/assertion reads go through pool A; the race pairs one
// mutation on A against one on B (and case 1 alternates A/B across N calls).
const db = dbA;

// Every contact and providerUserId this suite creates carries this per-run
// prefix, and `afterAll` deletes exactly this namespace
// (resolve-policy-trusted-kinds idiom). Never a whole-table count/truncate —
// other suites share this database.
const RUN = `alconc-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

let seq = 0;
const uid = (label: string) => `${RUN}-${label}-${seq++}`;
const prov = (label: string) => `${RUN}-${label}`;

async function makeContact(): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values({ externalId: uid("ext") })
    .returning({ id: contacts.id });
  if (!row) throw new Error("contact insert failed");
  return row.id;
}

type LinkInput = Parameters<typeof linkAccount>[0];
type Db = typeof db;

function linkInput(
  over: Partial<LinkInput> & {
    db: Db;
    contactId: string;
    provider: string;
    identity: LinkInput["identity"];
  },
): LinkInput {
  return {
    method: "oauth",
    multiple: true,
    onConflict: "replace",
    storeTokens: false,
    allowDisplaceLiveOwner: false,
    ...over,
  };
}

/** Capture-only logger: case 4 asserts the retry path NEVER fired (a sorted
 * lock set means the deadlock does not happen at all, not merely that the
 * bounded retry rescued a 40P01 victim). */
function captureLogger(): {
  logger: NonNullable<LinkInput["logger"]>;
  warns: Array<{ msg: string; meta: unknown }>;
} {
  const warns: Array<{ msg: string; meta: unknown }> = [];
  const noop = () => logger;
  const logger = {
    warn: (msg: string, meta?: unknown) => {
      warns.push({ msg, meta });
      return logger;
    },
    info: noop,
    error: noop,
    debug: noop,
  } as unknown as NonNullable<LinkInput["logger"]>;
  return { logger, warns };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pairRows(provider: string, providerUserId: string) {
  return db
    .select()
    .from(linkedAccounts)
    .where(
      and(
        eq(linkedAccounts.provider, provider),
        eq(linkedAccounts.providerUserId, providerUserId),
      ),
    );
}

type PairRow = Awaited<ReturnType<typeof pairRows>>[number];

/**
 * The version invariants every case shares. NOTE on "1..k with no gaps": a
 * relink OVERWRITES the displaced row's version (v1 → v2 on the soft-unlink,
 * DECISIONS §5 / the T3 two-version design), so the FINAL rows never retain
 * every historical version — the observable law is: all versions distinct,
 * at most one live row, and the live row (when present) holds the strict
 * maximum. Case-specific assertions pin the exact expected multiset, which
 * is deterministic per case and is where a duplicate or a gap actually shows.
 */
function assertVersionInvariants(rows: PairRow[]): {
  versions: bigint[];
  live: PairRow[];
} {
  const versions = rows
    .map((r) => BigInt(r.version))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // Every row's version is unique — a duplicate is the lost race the
  // advisory lock exists to prevent (and the 23505 backstop to catch).
  expect(new Set(versions.map(String)).size).toBe(versions.length);
  const live = rows.filter((r) => r.unlinkedAt === null);
  expect(live.length).toBeLessThanOrEqual(1);
  const liveRow = live[0];
  if (liveRow && versions.length > 0) {
    // The surviving live row holds the highest version: any interleaving
    // where a stale mutation landed after the winner breaks this.
    expect(BigInt(liveRow.version)).toBe(versions[versions.length - 1]);
  }
  return { versions, live };
}

afterAll(async () => {
  await db
    .delete(linkedAccounts)
    .where(like(linkedAccounts.provider, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}-%`));
  await poolA.client.end();
  await poolB.client.end();
});

describe("account link store — genuine concurrency (T7)", () => {
  // -------------------------------------------------------------------------
  // Case 1 — N concurrent displacing links for the SAME pair
  // -------------------------------------------------------------------------
  it("N concurrent displacing linkAccount calls for one pair serialize to distinct versions and one live row", {
    timeout: 60_000,
  }, async () => {
    const N = 10;
    const provider = prov("c1");
    const providerUserId = uid("u");
    const contactIds = await Promise.all(
      Array.from({ length: N }, () => makeContact()),
    );

    // All N fire together; alternating pools guarantees the calls occupy
    // different connections and genuinely interleave at the lock.
    const results = await Promise.all(
      contactIds.map((contactId, i) =>
        linkAccount(
          linkInput({
            db: i % 2 === 0 ? dbA : dbB,
            contactId,
            provider,
            identity: { providerUserId },
            allowDisplaceLiveOwner: true,
          }),
        ),
      ),
    );

    // Under the lock every call succeeds: exactly one arrives at an empty
    // pair ("linked"), the other N-1 displace a live owner ("relinked").
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === "linked")).toHaveLength(1);
    expect(statuses.filter((s) => s === "relinked")).toHaveLength(N - 1);

    const rows = await pairRows(provider, providerUserId);
    expect(rows).toHaveLength(N);
    const { versions, live } = assertVersionInvariants(rows);

    // Exactly ONE live row, owned by one of the racers.
    expect(live).toHaveLength(1);
    expect(contactIds).toContain(live[0]?.contactId);

    // The version LADDER is fully deterministic regardless of arrival
    // order: the first link burns v1, each of the N-1 relinks burns two
    // (soft-unlink at MAX+1, insert at MAX+2), so the displaced rows carry
    // exactly the even versions 2..2N-2 and the live row 2N-1. Any
    // duplicate version, any gap (a version computed outside the lock),
    // or any escaped 23505 breaks this exact multiset.
    const expected = [
      ...Array.from({ length: N - 1 }, (_, i) => BigInt(2 * (i + 1))),
      BigInt(2 * N - 1),
    ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(versions).toEqual(expected);

    // Every returned version is a string and distinct across calls.
    const returnedVersions = results.flatMap((r) =>
      r.status === "linked" || r.status === "relinked" ? [r.version] : [],
    );
    expect(new Set(returnedVersions).size).toBe(N);
    for (const v of returnedVersions) expect(typeof v).toBe("string");
  });

  // -------------------------------------------------------------------------
  // Case 2 — concurrent linkAccount + unlinkAccount for the same pair
  // -------------------------------------------------------------------------
  it("concurrent linkAccount and unlinkAccount for one pair keep the version invariants", {
    timeout: 60_000,
  }, async () => {
    const provider = prov("c2");
    const providerUserId = uid("u");
    const cSeed = await makeContact();
    const cNew = await makeContact();

    // Seed a live owner at v1, then race a displacing link against an
    // unguarded unlink on the two independent connections.
    const seeded = await linkAccount(
      linkInput({
        db,
        contactId: cSeed,
        provider,
        identity: { providerUserId },
      }),
    );
    expect(seeded.status).toBe("linked");

    const [linkResult, unlinkResult] = await Promise.all([
      linkAccount(
        linkInput({
          db: dbA,
          contactId: cNew,
          provider,
          identity: { providerUserId },
          allowDisplaceLiveOwner: true,
        }),
      ),
      unlinkAccount({ db: dbB, provider, providerUserId, reason: "api" }),
    ]);

    const rows = await pairRows(provider, providerUserId);
    const { versions, live } = assertVersionInvariants(rows);

    // Two serializations exist, each with an exact ladder:
    //  link first : relink burns v2+v3, then unlink bumps the new row to
    //               v4 → rows {2,4}, no live row, unlink status "unlinked".
    //  unlink first: seed row unlinked at v2, then the link inserts fresh
    //               at v3 → rows {2,3}, live row v3 owned by cNew.
    expect(
      linkResult.status === "relinked" || linkResult.status === "linked",
    ).toBe(true);
    const sorted = versions.map(String);
    if (unlinkResult.status === "unlinked" && live.length === 0) {
      // The unlink landed on the freshly relinked row (link first).
      expect(linkResult.status).toBe("relinked");
      expect(sorted).toEqual(["2", "4"]);
    } else if (live.length === 1) {
      // The unlink hit the seed row first; the link then started clean —
      // or the unlink lost entirely (not_found is impossible here since a
      // live row existed throughout, but the shape assertion below covers
      // whichever branch ran).
      expect(live[0]?.contactId).toBe(cNew);
      expect(sorted).toEqual(["2", "3"]);
    } else {
      throw new Error(
        `unexpected end state: versions=${sorted.join(",")} live=${live.length} unlink=${unlinkResult.status}`,
      );
    }
  });

  // -------------------------------------------------------------------------
  // Case 3 — different pairs never serialize on each other
  // -------------------------------------------------------------------------
  it("concurrent mutations for DIFFERENT pairs both complete with version 1", {
    timeout: 30_000,
  }, async () => {
    const provider = prov("c3");
    const [c1, c2] = await Promise.all([makeContact(), makeContact()]);
    const uidA = uid("a");
    const uidB = uid("b");

    // Assert on completion + version, never wall-clock (flaky in CI): two
    // pairs share no advisory lock key, so each mutation sees an empty
    // pair and computes version 1 — any cross-pair serialization artifact
    // (a shared lock, a cross-pair MAX) would surface as a wrong version
    // or a hang, not a timing delta.
    const [r1, r2] = await Promise.all([
      linkAccount(
        linkInput({
          db: dbA,
          contactId: c1 as string,
          provider,
          identity: { providerUserId: uidA },
        }),
      ),
      linkAccount(
        linkInput({
          db: dbB,
          contactId: c2 as string,
          provider,
          identity: { providerUserId: uidB },
        }),
      ),
    ]);
    expect(r1.status).toBe("linked");
    expect(r2.status).toBe("linked");
    if (r1.status === "linked") expect(r1.version).toBe("1");
    if (r2.status === "linked") expect(r2.version).toBe("1");
  });

  // -------------------------------------------------------------------------
  // Case 4 — the mirror-image singleton swap (the T3 lock-ordering case)
  // -------------------------------------------------------------------------
  it("mirror-image multiple:false replaces never deadlock (20+ iterations)", {
    timeout: 180_000,
  }, async () => {
    // Two players swapping platform accounts: C1 links pair A (held by
    // C2, and C2's singleton), C2 links pair B (held by C1, and C1's
    // singleton). Each mutation therefore locks TWO pairs — staged
    // acquisition (second lock taken inside the T4 branch) is the
    // textbook AB/BA deadlock, and Postgres kills a victim with 40P01.
    // A deadlock is timing-dependent, so one pass proves nothing: loop.
    const ITERATIONS = 24;
    const { logger, warns } = captureLogger();

    for (let i = 0; i < ITERATIONS; i++) {
      const provider = prov(`c4-${i}`);
      const c1 = await makeContact();
      const c2 = await makeContact();
      const pairA = uid("a");
      const pairB = uid("b");

      const single = (over: {
        db: Db;
        contactId: string;
        providerUserId: string;
      }) =>
        linkInput({
          db: over.db,
          contactId: over.contactId,
          provider,
          identity: { providerUserId: over.providerUserId },
          multiple: false,
          onConflict: "replace",
          allowDisplaceLiveOwner: true,
          logger,
        });

      // Seed: A live-owned by C2 (C2's singleton), B live-owned by C1
      // (C1's singleton).
      const seedA = await linkAccount(
        single({ db, contactId: c2, providerUserId: pairA }),
      );
      const seedB = await linkAccount(
        single({ db, contactId: c1, providerUserId: pairB }),
      );
      expect(seedA.status).toBe("linked");
      expect(seedB.status).toBe("linked");

      // The swap, genuinely concurrent on the two connections. Promise.all
      // rejects if either surfaces 40P01 (or exhausts the retry budget as
      // AccountLinkVersionRaceError).
      const [swapA, swapB] = await Promise.all([
        linkAccount(single({ db: dbA, contactId: c1, providerUserId: pairA })),
        linkAccount(single({ db: dbB, contactId: c2, providerUserId: pairB })),
      ]);
      expect(["linked", "relinked"]).toContain(swapA.status);
      expect(["linked", "relinked"]).toContain(swapB.status);

      // Whichever swap serialized first, the end state is symmetric:
      // each pair holds exactly 2 rows {v2 unlinked, v3 live}, live-owned
      // by the contact that swapped onto it.
      for (const [pair, owner] of [
        [pairA, c1],
        [pairB, c2],
      ] as const) {
        const rows = await pairRows(provider, pair);
        expect(rows).toHaveLength(2);
        const { versions, live } = assertVersionInvariants(rows);
        expect(live).toHaveLength(1);
        expect(live[0]?.contactId).toBe(owner);
        expect(versions.map(String)).toEqual(["2", "3"]);
      }
    }

    // The retry machinery must never have fired: with the full lock set
    // sorted as the transaction's FIRST statement there is no cycle to
    // break, so no 40P01 victim to rescue. Asserting on the retry LOG
    // (not just the results) is what catches a staged-lock regression the
    // bounded retry would otherwise paper over.
    const retryWarns = warns.filter((w) =>
      w.msg.includes("accountLink mutation retrying"),
    );
    expect(retryWarns).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Case 5 — expectContactId racing a displacing relink
  // -------------------------------------------------------------------------
  it("a revoke racing a relink never unlinks the new owner's link", {
    timeout: 120_000,
  }, async () => {
    // Contact A holds pair P; A's guarded revoke races a displacing link
    // moving P to contact B. Alternate the bias so BOTH orderings are hit
    // deterministically-ish: even iterations delay the unlink (link tends
    // to land first → the guard must reject not_owner), odd iterations
    // delay the link (unlink lands first → the link supersedes it).
    const ITERATIONS = 16;
    let sawUnlinkFirst = 0;
    let sawLinkFirst = 0;

    for (let i = 0; i < ITERATIONS; i++) {
      const provider = prov(`c5-${i}`);
      const providerUserId = uid("p");
      const contactA = await makeContact();
      const contactB = await makeContact();

      const seeded = await linkAccount(
        linkInput({
          db,
          contactId: contactA,
          provider,
          identity: { providerUserId },
        }),
      );
      expect(seeded.status).toBe("linked");

      const jitter = 2 + (i % 3);
      const [unlinkResult, linkResult] = await Promise.all([
        (async () => {
          if (i % 2 === 0) await sleep(jitter);
          return unlinkAccount({
            db: dbA,
            provider,
            providerUserId,
            reason: "player",
            // THE guard under test: evaluated inside the pair lock, after
            // the live-owner probe. Dropping it turns the link-first
            // ordering into "A's revoke destroys B's just-proven link".
            expectContactId: contactA,
          });
        })(),
        (async () => {
          if (i % 2 === 1) await sleep(jitter);
          return linkAccount(
            linkInput({
              db: dbB,
              contactId: contactB,
              provider,
              identity: { providerUserId },
              allowDisplaceLiveOwner: true,
            }),
          );
        })(),
      ]);

      // B's link always survives: whichever ordering won, the final live
      // row exists and belongs to B. THE forbidden end state — B's fresh
      // link soft-unlinked by A's revoke — has no live row (or a live row
      // that isn't B's).
      expect(["linked", "relinked"]).toContain(linkResult.status);
      const live = await getLiveLink({ db, provider, providerUserId });
      expect(live).not.toBeNull();
      expect(live?.contactId).toBe(contactB);

      const rows = await pairRows(provider, providerUserId);
      assertVersionInvariants(rows);

      if (unlinkResult.status === "unlinked") {
        // A's unlink won the lock first: it may only ever have unlinked
        // A's OWN row — never B's. B then linked a clean pair.
        sawUnlinkFirst++;
        expect(unlinkResult.row.contactId).toBe(contactA);
        expect(linkResult.status).toBe("linked");
        expect(rows.map((r) => String(r.version)).sort()).toEqual(["2", "3"]);
      } else {
        // B's relink won: A's guarded revoke found the live owner is now
        // B, rejected not_owner, and mutated NOTHING (B's row still live
        // at the relink's version).
        sawLinkFirst++;
        expect(unlinkResult).toEqual({
          status: "rejected",
          reason: "not_owner",
          currentOwnerContactId: contactB,
        });
        expect(linkResult.status).toBe("relinked");
        expect(rows.map((r) => String(r.version)).sort()).toEqual(["2", "3"]);
      }
    }

    // Both orderings must actually have been exercised — a suite that only
    // ever saw one ordering never tested the guard's rejecting branch.
    expect(sawUnlinkFirst).toBeGreaterThan(0);
    expect(sawLinkFirst).toBeGreaterThan(0);
  });
});
