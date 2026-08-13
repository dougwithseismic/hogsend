import { contacts, createDatabase, linkedAccounts } from "@hogsend/db";
import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// PRD 02 T5 — the four `linked_accounts` indexes ARE the feature: the live
// index is the core security invariant (one live owner per platform account),
// the singleton index is the ONLY place `multiple: false` is enforced, and the
// version index is the lost-race backstop for the consistency contract
// (DECISIONS §5.6). Each case below asserts the SQLSTATE **and** the constraint
// name, so dropping the index under test turns the case red rather than letting
// some other constraint keep it green.
//
// Runs against the repo's real local Postgres on 5434 (docker compose), the
// same convention as the rest of the DB-backed suite. Every row is namespaced
// by RUN and cleaned in afterAll; no assertion is a whole-table count.
const DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { db, client } = createDatabase({ url: DATABASE_URL });

const RUN = `las-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const PROVIDER = `${RUN}-steam`;

const contactIds: string[] = [];

/** Walk the wrapped drizzle error for the raw postgres error fields. */
function pgError(err: unknown): { code?: string; constraint_name?: string } {
  let cur: unknown = err;
  for (let i = 0; i < 10 && cur; i += 1) {
    const e = cur as {
      code?: unknown;
      constraint_name?: unknown;
      cause?: unknown;
    };
    if (typeof e.code === "string") {
      return {
        code: e.code,
        constraint_name:
          typeof e.constraint_name === "string" ? e.constraint_name : undefined,
      };
    }
    cur = e.cause;
  }
  return {};
}

/** Assert `fn` rejects with a 23505 raised by exactly `constraint`. */
async function expectUniqueViolation(
  fn: () => Promise<unknown>,
  constraint: string,
): Promise<void> {
  let thrown: unknown;
  try {
    await fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown, `expected ${constraint} to reject the write`).toBeDefined();
  const { code, constraint_name } = pgError(thrown);
  expect(code).toBe("23505");
  expect(constraint_name).toBe(constraint);
}

async function makeContact(label: string): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values({ externalId: `${RUN}-${label}` })
    .returning({ id: contacts.id });
  if (!row) throw new Error("contact insert returned no row");
  contactIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  // Fail loudly and early if the migration has not been applied.
  await db.select({ id: linkedAccounts.id }).from(linkedAccounts).limit(1);
});

afterAll(async () => {
  await db
    .delete(linkedAccounts)
    .where(like(linkedAccounts.provider, `${RUN}%`));
  if (contactIds.length > 0) {
    await db.delete(contacts).where(inArray(contacts.id, contactIds));
  }
  await client.end();
});

describe("linked_accounts schema", () => {
  it("rejects a second live row for the same provider and provider_user_id", async () => {
    const a = await makeContact("live-a");
    const b = await makeContact("live-b");
    const uid = `${RUN}-uid-live`;

    await db.insert(linkedAccounts).values({
      contactId: a,
      provider: PROVIDER,
      providerUserId: uid,
      version: 1n,
    });

    await expectUniqueViolation(
      () =>
        db.insert(linkedAccounts).values({
          contactId: b,
          provider: PROVIDER,
          providerUserId: uid,
          version: 2n,
        }),
      "linked_accounts_provider_uid_live_idx",
    );
  });

  it("allows a new live row after the previous one is soft-unlinked", async () => {
    const a = await makeContact("relink-a");
    const b = await makeContact("relink-b");
    const uid = `${RUN}-uid-relink`;

    const [first] = await db
      .insert(linkedAccounts)
      .values({
        contactId: a,
        provider: PROVIDER,
        providerUserId: uid,
        version: 1n,
      })
      .returning({ id: linkedAccounts.id });
    if (!first) throw new Error("insert returned no row");

    await db
      .update(linkedAccounts)
      .set({ unlinkedAt: new Date(), unlinkReason: "relinked" })
      .where(eq(linkedAccounts.id, first.id));

    // The partial predicate is what makes a relink possible at all.
    const [second] = await db
      .insert(linkedAccounts)
      .values({
        contactId: b,
        provider: PROVIDER,
        providerUserId: uid,
        version: 2n,
      })
      .returning({ id: linkedAccounts.id });
    expect(second?.id).toBeDefined();
  });

  it("rejects a duplicate (provider, provider_user_id, version) even when one row is unlinked", async () => {
    const a = await makeContact("ver-a");
    const b = await makeContact("ver-b");
    const uid = `${RUN}-uid-version`;

    const [first] = await db
      .insert(linkedAccounts)
      .values({
        contactId: a,
        provider: PROVIDER,
        providerUserId: uid,
        version: 7n,
      })
      .returning({ id: linkedAccounts.id });
    if (!first) throw new Error("insert returned no row");

    // Unlink the first so the LIVE index cannot be the constraint that fires —
    // this case must be attributable to the version index alone.
    await db
      .update(linkedAccounts)
      .set({ unlinkedAt: new Date(), unlinkReason: "relinked" })
      .where(eq(linkedAccounts.id, first.id));

    await expectUniqueViolation(
      () =>
        db.insert(linkedAccounts).values({
          contactId: b,
          provider: PROVIDER,
          providerUserId: uid,
          version: 7n,
        }),
      "linked_accounts_provider_uid_version_idx",
    );
  });

  it("rejects a second live singleton row for the same (contact, provider)", async () => {
    const c = await makeContact("singleton");

    await db.insert(linkedAccounts).values({
      contactId: c,
      provider: PROVIDER,
      providerUserId: `${RUN}-uid-single-1`,
      singleton: true,
      version: 1n,
    });

    await expectUniqueViolation(
      () =>
        db.insert(linkedAccounts).values({
          contactId: c,
          provider: PROVIDER,
          providerUserId: `${RUN}-uid-single-2`,
          singleton: true,
          version: 2n,
        }),
      "linked_accounts_contact_provider_singleton_idx",
    );
  });

  it("allows many live non-singleton rows for the same (contact, provider)", async () => {
    const c = await makeContact("multi");

    for (let i = 0; i < 3; i += 1) {
      await db.insert(linkedAccounts).values({
        contactId: c,
        provider: PROVIDER,
        providerUserId: `${RUN}-uid-multi-${i}`,
        singleton: false,
        version: BigInt(i + 1),
      });
    }

    const rows = await db
      .select({ id: linkedAccounts.id })
      .from(linkedAccounts)
      .where(eq(linkedAccounts.contactId, c));
    expect(rows).toHaveLength(3);
  });

  it("cascades on a hard contact delete (backstop; no production path hard-deletes)", async () => {
    // This is a DATABASE-LEVEL BACKSTOP ONLY and a green here must NOT be read
    // as "contact deletion is handled". No production path in this repo
    // hard-deletes a contact: merge soft-deletes the loser, and both
    // `softDeleteContact` and the admin delete route set `deletedAt`. Soft-
    // unlinking a deleted contact's live links (and repointing them on merge)
    // is owned by the account-link store work (DECISIONS §15.3); until that
    // ships, a live row outlives its owner and keeps the (provider,
    // provider_user_id) pair permanently locked.
    const c = await makeContact("cascade");
    await db.insert(linkedAccounts).values({
      contactId: c,
      provider: PROVIDER,
      providerUserId: `${RUN}-uid-cascade`,
      version: 1n,
    });

    await db.delete(contacts).where(eq(contacts.id, c));

    const rows = await db
      .select({ id: linkedAccounts.id })
      .from(linkedAccounts)
      .where(eq(linkedAccounts.contactId, c));
    expect(rows).toHaveLength(0);
  });

  it("a version above Number.MAX_SAFE_INTEGER round-trips without loss", async () => {
    const c = await makeContact("bigint");
    // 2^53 + 1 — the smallest integer a JS `number` cannot represent.
    const big = 9007199254740993n;
    // Proof the value is genuinely out of `number` range: coercing it loses a
    // digit. (Comparing against a numeric LITERAL would not prove anything —
    // the literal rounds identically at parse time.)
    expect(String(Number(big))).toBe("9007199254740992");
    expect(Number.isSafeInteger(Number(big))).toBe(false);

    await db.insert(linkedAccounts).values({
      contactId: c,
      provider: PROVIDER,
      providerUserId: `${RUN}-uid-bigint`,
      version: big,
    });

    const [row] = await db
      .select({ version: linkedAccounts.version })
      .from(linkedAccounts)
      .where(eq(linkedAccounts.contactId, c));

    // `mode: "bigint"` — a JS BigInt, never a rounded `number`. This case goes
    // red the moment the column is switched to `mode: "number"` (DECISIONS §5.1).
    expect(typeof row?.version).toBe("bigint");
    expect(String(row?.version)).toBe("9007199254740993");
  });
});
