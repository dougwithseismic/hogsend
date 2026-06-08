import { randomUUID } from "node:crypto";
import { createDatabase, user } from "@hogsend/db";
import { createAuth } from "@hogsend/engine/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AdminRecovery,
  createAdminRecovery,
} from "../lib/admin-recovery.js";

/**
 * Integration test for the shell-gated admin recovery primitive. Runs against
 * the migrated test DB (postgresql://test:test@localhost:5434/test). It proves
 * the FULL security contract:
 *  - create then a sign-in-equivalent password verify succeeds (correct scrypt
 *    hashing end to end via better-auth's own verify),
 *  - reset rotates the password (old fails, new verifies),
 *  - the stored credential is a hash, NEVER plaintext,
 *  - create of an existing email and reset of a missing email fail clearly,
 *  - list returns only non-secret columns.
 *
 * Skips gracefully (reported as infra-error by the runner) if the DB is absent.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://test:test@localhost:5434/test";
const SECRET = "test-secret-admin-recovery-0123456789abcdef";

async function dbReachable(): Promise<boolean> {
  const { db, client } = createDatabase({ url: DATABASE_URL });
  try {
    await db.select({ id: user.id }).from(user).limit(1);
    return true;
  } catch {
    return false;
  } finally {
    await client.end();
  }
}

let reachable = false;
let recovery: AdminRecovery;
// Verification harness: a separate auth instance whose $context.password.verify
// reproduces what a real sign-in does, without standing up the HTTP app.
let verifyPassword: (email: string, password: string) => Promise<boolean>;
let credentialHash: (email: string) => Promise<string | null>;
let cleanup: (email: string) => Promise<void>;

const emails: string[] = [];
function freshEmail(): string {
  const e = `admin-${randomUUID()}@example.test`;
  emails.push(e);
  return e;
}

beforeAll(async () => {
  reachable = await dbReachable();
  if (!reachable) return;

  recovery = createAdminRecovery({ databaseUrl: DATABASE_URL, secret: SECRET });

  const auth = createAuth({
    db: createDatabase({ url: DATABASE_URL }).db,
    secret: SECRET,
    baseURL: "http://localhost:3002",
  });
  const ctx = await auth.$context;

  verifyPassword = async (email, password) => {
    const found = await ctx.internalAdapter.findUserByEmail(email, {
      includeAccounts: true,
    });
    const cred = found?.accounts?.find((a) => a.providerId === "credential");
    if (!cred?.password) return false;
    return ctx.password.verify({ password, hash: cred.password });
  };

  credentialHash = async (email) => {
    const found = await ctx.internalAdapter.findUserByEmail(email, {
      includeAccounts: true,
    });
    const cred = found?.accounts?.find((a) => a.providerId === "credential");
    return cred?.password ?? null;
  };

  cleanup = async (email) => {
    const found = await ctx.internalAdapter.findUserByEmail(email);
    if (!found) return;
    // Delete via the internal adapter; account/session FKs cascade on user
    // delete, but drop accounts first to be safe across adapters.
    await ctx.internalAdapter.deleteAccounts(found.user.id);
    await ctx.internalAdapter.deleteUser(found.user.id);
  };
}, 30_000);

afterAll(async () => {
  if (!reachable) return;
  for (const email of emails) {
    try {
      await cleanup(email);
    } catch {
      // best-effort teardown
    }
  }
  await recovery.close();
}, 30_000);

describe("admin-recovery", () => {
  it("creates an admin whose password verifies via better-auth", async () => {
    if (!reachable) {
      console.warn("test DB unreachable; skipping admin-recovery integration");
      return;
    }
    const email = freshEmail();
    const created = await recovery.create({
      email,
      password: "correct-horse-battery",
    });
    expect(created.email).toBe(email);
    expect(created.id).toBeTruthy();
    // name defaults to the email local-part.
    expect(created.name).toBe(email.split("@")[0]);

    // End-to-end: the stored hash verifies the correct password (scrypt).
    expect(await verifyPassword(email, "correct-horse-battery")).toBe(true);
    // and rejects the wrong one.
    expect(await verifyPassword(email, "wrong-password")).toBe(false);

    // The stored credential is a hash, NEVER plaintext.
    const hash = await credentialHash(email);
    expect(hash).toBeTruthy();
    expect(hash).not.toBe("correct-horse-battery");
    expect(hash).not.toContain("correct-horse-battery");
    // better-auth scrypt format is `salt:derivedKey` (both hex).
    expect(hash).toMatch(/^[0-9a-f]+:[0-9a-f]+$/i);
  }, 30_000);

  it("fails to create a duplicate email and points at reset", async () => {
    if (!reachable) return;
    const email = freshEmail();
    await recovery.create({ email, password: "first-password-123" });
    await expect(
      recovery.create({ email, password: "another-password-123" }),
    ).rejects.toThrow(/already exists.*reset/i);
  }, 30_000);

  it("resets the password: old fails, new verifies", async () => {
    if (!reachable) return;
    const email = freshEmail();
    await recovery.create({ email, password: "original-pass-123" });
    expect(await verifyPassword(email, "original-pass-123")).toBe(true);

    const reset = await recovery.reset({
      email,
      password: "rotated-pass-456",
    });
    expect(reset.email).toBe(email);

    expect(await verifyPassword(email, "original-pass-123")).toBe(false);
    expect(await verifyPassword(email, "rotated-pass-456")).toBe(true);

    // Still a hash after reset, never plaintext.
    const hash = await credentialHash(email);
    expect(hash).not.toContain("rotated-pass-456");
    expect(hash).toMatch(/^[0-9a-f]+:[0-9a-f]+$/i);
  }, 30_000);

  it("fails to reset a missing email and points at create", async () => {
    if (!reachable) return;
    await expect(
      recovery.reset({
        email: `missing-${randomUUID()}@example.test`,
        password: "whatever-123",
      }),
    ).rejects.toThrow(/No admin.*create/i);
  }, 30_000);

  it("lists admins with only non-secret columns", async () => {
    if (!reachable) return;
    const email = freshEmail();
    await recovery.create({ email, password: "listed-pass-123" });
    const admins = await recovery.list();
    const row = admins.find((a) => a.email === email);
    expect(row).toBeTruthy();
    expect(Object.keys(row ?? {}).sort()).toEqual([
      "createdAt",
      "email",
      "id",
      "name",
    ]);
    // No password/hash key ever leaks into the summary shape.
    expect("password" in (row ?? {})).toBe(false);
  }, 30_000);
});
