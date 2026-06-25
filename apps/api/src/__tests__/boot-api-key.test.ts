import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Point at the local growthhog Timescale (matches the other live-DB suites).
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Hatchet is module-mocked so building a container never dials a live engine.
vi.mock("../lib/hatchet.js", () => ({
  hatchet: {
    durableTask: vi.fn(() => ({
      run: vi.fn(),
      runNoWait: vi.fn(),
      runAndWait: vi.fn(),
    })),
    task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
    events: { push: vi.fn() },
    runs: { cancel: vi.fn(), get: vi.fn() },
    worker: vi.fn(),
  },
}));

const { apiKeys } = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");
const { bootstrapApiKeyFromEnv, createHogsendClient } = await import(
  "@hogsend/engine"
);

type Container = ReturnType<typeof createHogsendClient>;

const BOOTSTRAP_KEY_NAME = "bootstrap-ingest";

/**
 * First-boot data-plane key bootstrap (lib/boot-api-key.ts) — the api_keys
 * sibling of `bootstrapAdminFromEnv`:
 *
 *  1. TRULY empty api_keys table ⇒ boot mints exactly ONE ingest-scoped key
 *     ("bootstrap-ingest", sha256 hash stored, full key warn-logged once).
 *  2. Non-empty table (revoked rows included) ⇒ no-op — which also makes the
 *     local scaffold `pnpm bootstrap` flow safe: it mints BEFORE first boot.
 *  3. HOGSEND_BOOTSTRAP_API_KEY=false ⇒ no-op even on an empty table.
 *
 * DB-backed like auth-pivot.test.ts: skips gracefully when the DB is
 * unreachable, and (since the shared dev DB may already hold real keys) the
 * empty-table mint is asserted only when the table is actually empty —
 * otherwise the non-empty no-op contract is asserted instead.
 */

async function dbReachable(db: Container["db"]): Promise<boolean> {
  try {
    await db.select({ id: apiKeys.id }).from(apiKeys).limit(1);
    return true;
  } catch {
    return false;
  }
}

function setBootstrapFlag(container: Container, value: "true" | "false") {
  (
    container.env as { HOGSEND_BOOTSTRAP_API_KEY?: "true" | "false" }
  ).HOGSEND_BOOTSTRAP_API_KEY = value;
}

describe("bootstrapApiKeyFromEnv", () => {
  let container: Container;
  let reachable = false;

  beforeEach(async () => {
    container = createHogsendClient();
    reachable = await dbReachable(container.db);
    if (reachable) {
      // Clear any stale bootstrap key a PRIOR run left behind (e.g. a run
      // killed before its afterEach committed) so the empty/no-op assertions
      // start from a known state — the suite owns this name exclusively.
      await container.db
        .delete(apiKeys)
        .where(eq(apiKeys.name, BOOTSTRAP_KEY_NAME))
        .catch(() => {});
    }
  });

  afterEach(async () => {
    if (reachable) {
      // Only ever delete the row THIS suite can have minted.
      await container.db
        .delete(apiKeys)
        .where(eq(apiKeys.name, BOOTSTRAP_KEY_NAME))
        .catch(() => {});
    }
    await container.dbClient.end({ timeout: 5 }).catch(() => {});
    vi.restoreAllMocks();
  });

  it("no-ops when HOGSEND_BOOTSTRAP_API_KEY=false (even on an empty table)", async () => {
    if (!reachable) {
      console.warn("test DB unreachable; skipping opt-out assertion");
      return;
    }
    setBootstrapFlag(container, "false");
    const warnSpy = vi.spyOn(container.logger, "warn");

    const before = await container.db.select({ id: apiKeys.id }).from(apiKeys);
    await bootstrapApiKeyFromEnv({ client: container });
    const after = await container.db.select({ id: apiKeys.id }).from(apiKeys);

    expect(after.length).toBe(before.length);
    const minted = await container.db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(eq(apiKeys.name, BOOTSTRAP_KEY_NAME));
    expect(minted).toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("empty table → mints exactly one ingest key; non-empty → no-op", async () => {
    if (!reachable) {
      console.warn("test DB unreachable; skipping bootstrap mint assertion");
      return;
    }
    setBootstrapFlag(container, "true");

    const existing = await container.db
      .select({ id: apiKeys.id })
      .from(apiKeys);

    if (existing.length > 0) {
      // Shared dev DB already holds keys (e.g. the local-bootstrap hsk_ key):
      // the boot mint must be a no-op — exactly the contract that keeps the
      // scaffold's pre-boot `pnpm bootstrap` mint authoritative.
      console.warn(
        "api_keys not empty; boot mint is a no-op by design — verifying that",
      );
      const warnSpy = vi.spyOn(container.logger, "warn");
      await bootstrapApiKeyFromEnv({ client: container });
      const minted = await container.db
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(eq(apiKeys.name, BOOTSTRAP_KEY_NAME));
      expect(minted).toHaveLength(0);
      expect(warnSpy).not.toHaveBeenCalled();
      return;
    }

    const warnSpy = vi.spyOn(container.logger, "warn");
    await bootstrapApiKeyFromEnv({ client: container });

    // Exactly one row, ingest-scoped, hash-only at rest.
    const rows = await container.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.name, BOOTSTRAP_KEY_NAME));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.scopes).toEqual(["ingest"]);
    expect(row?.revokedAt).toBeNull();
    expect(row?.keyPrefix).toMatch(/^hsk_/);
    expect(row?.keyHash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex, never the key

    // The FULL key is warn-logged once, and hashes to the stored keyHash —
    // i.e. the printed key is exactly what the api-key middleware accepts.
    const warned = warnSpy.mock.calls.map((call) => String(call[0])).join("\n");
    const match = warned.match(/hsk_[A-Za-z0-9_-]+/);
    expect(match).not.toBeNull();
    const fullKey = match?.[0] as string;
    expect(createHash("sha256").update(fullKey).digest("hex")).toBe(
      row?.keyHash,
    );
    expect(fullKey.slice(0, 8)).toBe(row?.keyPrefix);

    // Re-run: table is non-empty now ⇒ no second key, no second key log.
    warnSpy.mockClear();
    await bootstrapApiKeyFromEnv({ client: container });
    const again = await container.db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(eq(apiKeys.name, BOOTSTRAP_KEY_NAME));
    expect(again).toHaveLength(1);
    expect(again[0]?.id).toBe(row?.id);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("no-ops when any key exists — even a revoked one (truly-first-boot gate)", async () => {
    if (!reachable) return;
    setBootstrapFlag(container, "true");

    // Seed a REVOKED key so the table is non-empty but holds no usable key.
    const seedName = `boot-api-key-test-revoked-${Date.now()}`;
    await container.db.insert(apiKeys).values({
      name: seedName,
      keyPrefix: "hsk_test",
      keyHash: createHash("sha256").update(seedName).digest("hex"),
      scopes: ["ingest"],
      revokedAt: new Date(),
    });

    try {
      const warnSpy = vi.spyOn(container.logger, "warn");
      await bootstrapApiKeyFromEnv({ client: container });
      const minted = await container.db
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(eq(apiKeys.name, BOOTSTRAP_KEY_NAME));
      expect(minted).toHaveLength(0);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      await container.db
        .delete(apiKeys)
        .where(eq(apiKeys.name, seedName))
        .catch(() => {});
    }
  });
});
