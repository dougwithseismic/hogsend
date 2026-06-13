import { createHash } from "node:crypto";
import {
  createLinkCode,
  generateLinkCode,
  hashLinkCode,
  LINK_CODE_MAX_PER_EMAIL,
  LINK_CODE_MAX_PER_USER,
  redeemLinkCode,
} from "@hogsend/engine";
import { describe, expect, it, vi } from "vitest";

/**
 * DB-free unit tests for the engine-owned single-use link-code helpers
 * (`createLinkCode` / `redeemLinkCode`). They mirror the `frequency-cap.test.ts`
 * db-double pattern: a hand-rolled drizzle query-builder stub whose terminal
 * awaits resolve test-injected values, so we exercise the real helper logic
 * (throttle, hashing, single-use, identity-binding, TTL) without a live DB.
 */

const CONNECTOR = "discord";
const USER = "discord-user-111";
const EMAIL = "Alice@Example.com";

/**
 * A db double for `createLinkCode`. It serves the TWO throttle COUNTs in order
 * (user count, then email count) and records the inserted values so a test can
 * assert what was persisted.
 */
function makeCreateDb(opts: { userCount: number; emailCount: number }) {
  let selectCall = 0;
  const counts = [opts.userCount, opts.emailCount];
  const insertValues = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn().mockReturnValue({ values: insertValues });
  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          const n = counts[selectCall] ?? 0;
          selectCall += 1;
          return Promise.resolve([{ n }]);
        },
      }),
    }),
    insert,
  };
  // biome-ignore lint/suspicious/noExplicitAny: minimal test double
  return { db: db as any, insert, insertValues };
}

type FakeRow = {
  id: string;
  platformUserId: string;
  targetEmail: string;
  expiresAt: Date;
  usedAt: Date | null;
};

/**
 * A db double for `redeemLinkCode`. `row` is what the hash lookup returns
 * (`null` = no match); `claimRows` is what the atomic single-use UPDATE
 * RETURNING resolves to (`[]` = lost the race / already used).
 */
function makeRedeemDb(opts: {
  row: FakeRow | null;
  claimRows?: Array<{ id: string }>;
}) {
  const updateReturning = vi
    .fn()
    .mockResolvedValue(opts.claimRows ?? [{ id: opts.row?.id ?? "row-1" }]);
  const update = vi.fn().mockReturnValue({
    set: () => ({ where: () => ({ returning: updateReturning }) }),
  });
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(opts.row ? [opts.row] : []),
        }),
      }),
    }),
    update,
  };
  // biome-ignore lint/suspicious/noExplicitAny: minimal test double
  return { db: db as any, update, updateReturning };
}

describe("generateLinkCode / hashLinkCode", () => {
  it("generates a 6-digit zero-padded numeric code", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateLinkCode();
      expect(code).toMatch(/^\d{6}$/);
    }
  });

  it("hashLinkCode is sha256 hex of the plaintext (never the plaintext)", () => {
    const code = "428917";
    const expected = createHash("sha256").update(code, "utf8").digest("hex");
    expect(hashLinkCode(code)).toBe(expected);
    expect(hashLinkCode(code)).not.toContain(code);
    expect(hashLinkCode(code)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("createLinkCode — throttle", () => {
  it("mints + persists a hashed code when under both caps", async () => {
    const { db, insertValues } = makeCreateDb({ userCount: 0, emailCount: 0 });
    const result = await createLinkCode({
      db,
      connectorId: CONNECTOR,
      platformUserId: USER,
      email: EMAIL,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code).toMatch(/^\d{6}$/);

    // The row stores the HASH (not the plaintext) and a normalized email.
    expect(insertValues).toHaveBeenCalledTimes(1);
    const persisted = insertValues.mock.calls[0]?.[0] as {
      codeHash: string;
      targetEmail: string;
      platformUserId: string;
      connectorId: string;
    };
    expect(persisted.codeHash).toBe(hashLinkCode(result.code));
    expect(persisted.codeHash).not.toContain(result.code);
    expect(persisted.targetEmail).toBe("alice@example.com");
    expect(persisted.platformUserId).toBe(USER);
    expect(persisted.connectorId).toBe(CONNECTOR);
  });

  it("refuses + does NOT mint when the per-user cap is already met", async () => {
    const { db, insert } = makeCreateDb({
      userCount: LINK_CODE_MAX_PER_USER,
      emailCount: 0,
    });
    const result = await createLinkCode({
      db,
      connectorId: CONNECTOR,
      platformUserId: USER,
      email: EMAIL,
    });

    expect(result).toEqual({
      ok: false,
      reason: "throttled",
      scope: "platformUser",
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("refuses + does NOT mint when the per-email cap is already met", async () => {
    const { db, insert } = makeCreateDb({
      userCount: 0,
      emailCount: LINK_CODE_MAX_PER_EMAIL,
    });
    const result = await createLinkCode({
      db,
      connectorId: CONNECTOR,
      platformUserId: USER,
      email: EMAIL,
    });

    expect(result).toEqual({
      ok: false,
      reason: "throttled",
      scope: "email",
    });
    expect(insert).not.toHaveBeenCalled();
  });
});

describe("redeemLinkCode", () => {
  const future = () => new Date(Date.now() + 60_000);
  const past = () => new Date(Date.now() - 60_000);

  it("redeems a valid, fresh, identity-matched code → bound email", async () => {
    const { db, update } = makeRedeemDb({
      row: {
        id: "row-1",
        platformUserId: USER,
        targetEmail: "alice@example.com",
        expiresAt: future(),
        usedAt: null,
      },
    });
    const result = await redeemLinkCode({
      db,
      connectorId: CONNECTOR,
      platformUserId: USER,
      code: "428917",
    });

    expect(result).toEqual({ ok: true, email: "alice@example.com" });
    // The single-use claim UPDATE ran exactly once.
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("rejects a code minted for a DIFFERENT platform user (no claim)", async () => {
    const { db, update } = makeRedeemDb({
      row: {
        id: "row-1",
        platformUserId: "some-other-user",
        targetEmail: "alice@example.com",
        expiresAt: future(),
        usedAt: null,
      },
    });
    const result = await redeemLinkCode({
      db,
      connectorId: CONNECTOR,
      platformUserId: USER,
      code: "428917",
    });

    expect(result).toEqual({ ok: false, reason: "wrong_user" });
    // A wrong-user redeem must NOT mark the code used.
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects an expired code", async () => {
    const { db, update } = makeRedeemDb({
      row: {
        id: "row-1",
        platformUserId: USER,
        targetEmail: "alice@example.com",
        expiresAt: past(),
        usedAt: null,
      },
    });
    const result = await redeemLinkCode({
      db,
      connectorId: CONNECTOR,
      platformUserId: USER,
      code: "428917",
    });

    expect(result).toEqual({ ok: false, reason: "expired" });
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects an already-used code (usedAt set on the read row)", async () => {
    const { db, update } = makeRedeemDb({
      row: {
        id: "row-1",
        platformUserId: USER,
        targetEmail: "alice@example.com",
        expiresAt: future(),
        usedAt: new Date(),
      },
    });
    const result = await redeemLinkCode({
      db,
      connectorId: CONNECTOR,
      platformUserId: USER,
      code: "428917",
    });

    expect(result).toEqual({ ok: false, reason: "used" });
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects a reuse that loses the atomic claim race (UPDATE → 0 rows)", async () => {
    // The read sees an unused row, but the claim UPDATE returns no rows — a
    // concurrent redeem flipped used_at first. Must resolve to `used`.
    const { db, updateReturning } = makeRedeemDb({
      row: {
        id: "row-1",
        platformUserId: USER,
        targetEmail: "alice@example.com",
        expiresAt: future(),
        usedAt: null,
      },
      claimRows: [],
    });
    const result = await redeemLinkCode({
      db,
      connectorId: CONNECTOR,
      platformUserId: USER,
      code: "428917",
    });

    expect(result).toEqual({ ok: false, reason: "used" });
    expect(updateReturning).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown/invalid code (no matching row)", async () => {
    const { db, update } = makeRedeemDb({ row: null });
    const result = await redeemLinkCode({
      db,
      connectorId: CONNECTOR,
      platformUserId: USER,
      code: "000000",
    });

    expect(result).toEqual({ ok: false, reason: "invalid" });
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects an empty code without touching the db", async () => {
    const { db, update } = makeRedeemDb({ row: null });
    const result = await redeemLinkCode({
      db,
      connectorId: CONNECTOR,
      platformUserId: USER,
      code: "   ",
    });

    expect(result).toEqual({ ok: false, reason: "invalid" });
    expect(update).not.toHaveBeenCalled();
  });
});
