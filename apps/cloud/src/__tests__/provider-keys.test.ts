import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import {
  cloudAuditLog,
  environments,
  organizations,
  providerKeys,
} from "../db/schema";
import { env } from "../env";
import { CloudDecryptError } from "../lib/crypto";
import { ProviderKeyService } from "../services/provider-keys";

/**
 * Against a REAL database — the upsert's conflict target is a Postgres index,
 * so a mocked driver would prove nothing about the "one row per (environment,
 * provider)" law this service depends on.
 *
 * Fixtures hang off one org id and are deleted in `afterAll`; the cascade takes
 * environments, keys and audit rows with it.
 */
const ORG_ID = "provider-keys-test-org";

/** Obvious fakes. Nothing here resembles a real credential. */
const FIRST_PAYLOAD = {
  apiKey: "fake_test_key_aaaaaaaa1111",
  fromEmail: "sender@example.test",
};
const SECOND_PAYLOAD = {
  apiKey: "fake_test_key_bbbbbbbb2222",
  fromEmail: "other@example.test",
};

const service = new ProviderKeyService(db);

function one<T>(rows: T[], what: string): T {
  const row = rows[0];
  if (!row) throw new Error(`expected exactly one ${what}, got none`);
  return row;
}

let environmentId: string;

async function cleanup(): Promise<void> {
  await db.delete(organizations).where(eq(organizations.id, ORG_ID));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();

  await db
    .insert(organizations)
    .values({ id: ORG_ID, name: "Provider Keys Test Org", region: "us" });

  environmentId = one(
    await db
      .insert(environments)
      .values({
        organizationId: ORG_ID,
        name: "production",
        kind: "production",
      })
      .returning(),
    "environment",
  ).id;
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
});

async function auditRows() {
  return db
    .select()
    .from(cloudAuditLog)
    .where(eq(cloudAuditLog.organizationId, ORG_ID))
    .orderBy(cloudAuditLog.createdAt);
}

describe("ProviderKeyService", () => {
  it("stores ciphertext + last4 and round-trips the exact payload", async () => {
    const stored = await service.store({
      organizationId: ORG_ID,
      environmentId,
      provider: "resend",
      payload: FIRST_PAYLOAD,
      actor: "user_test",
    });

    expect(stored.replaced).toBe(false);
    expect(stored.key.last4).toBe(FIRST_PAYLOAD.apiKey.slice(-4));
    expect(stored.key.verifiedAt).toBeNull();

    // The COLUMN must hold no plaintext.
    const row = one(
      await db
        .select()
        .from(providerKeys)
        .where(eq(providerKeys.id, stored.key.id)),
      "provider key",
    );
    expect(row.encryptedPayload.startsWith("v1:")).toBe(true);
    expect(row.encryptedPayload).not.toContain(FIRST_PAYLOAD.apiKey);
    expect(row.encryptedPayload).not.toContain("fromEmail");

    const read = await service.getDecrypted({
      environmentId,
      provider: "resend",
    });
    expect(read).toEqual({
      found: true,
      provider: "resend",
      payload: FIRST_PAYLOAD,
    });
  });

  it("returns a typed not-found rather than throwing for an absent key", async () => {
    expect(
      await service.getDecrypted({ environmentId, provider: "postmark" }),
    ).toEqual({ found: false });
  });

  it("replaces on re-store: one row, new last4, verified_at cleared", async () => {
    const verified = await service.markVerified({
      environmentId,
      provider: "resend",
    });
    expect(verified.found).toBe(true);

    const again = await service.store({
      organizationId: ORG_ID,
      environmentId,
      provider: "resend",
      payload: SECOND_PAYLOAD,
    });

    expect(again.replaced).toBe(true);
    expect(again.key.last4).toBe(SECOND_PAYLOAD.apiKey.slice(-4));
    // The credential changed, so the earlier verification no longer applies.
    expect(again.key.verifiedAt).toBeNull();

    const rows = await db
      .select()
      .from(providerKeys)
      .where(
        and(
          eq(providerKeys.environmentId, environmentId),
          eq(providerKeys.provider, "resend"),
        ),
      );
    expect(rows).toHaveLength(1);

    const read = await service.getDecrypted({
      environmentId,
      provider: "resend",
    });
    expect(read).toEqual({
      found: true,
      provider: "resend",
      payload: SECOND_PAYLOAD,
    });
  });

  it("lists metadata only — never the payload or the ciphertext", async () => {
    await service.store({
      organizationId: ORG_ID,
      environmentId,
      provider: "twilio",
      payload: {
        authToken: "fake_twilio_token_cccc3333",
        accountSid: "ACfake",
      },
    });

    const { keys } = await service.list({ environmentId });
    expect(keys.map((k) => k.provider)).toEqual(["resend", "twilio"]);

    const serialized = JSON.stringify(keys);
    expect(serialized).not.toContain(SECOND_PAYLOAD.apiKey);
    expect(serialized).not.toContain("fake_twilio_token");
    expect(serialized).not.toContain("v1:");
    for (const key of keys) {
      expect(Object.keys(key)).not.toContain("encryptedPayload");
      expect(Object.keys(key)).not.toContain("payload");
    }
  });

  it("fails closed when the stored ciphertext is tampered with", async () => {
    // Corrupt the body while keeping a valid version prefix.
    const row = one(
      await db
        .select()
        .from(providerKeys)
        .where(
          and(
            eq(providerKeys.environmentId, environmentId),
            eq(providerKeys.provider, "twilio"),
          ),
        ),
      "provider key",
    );
    const raw = Buffer.from(row.encryptedPayload.slice(3), "base64url");
    raw[20] = (raw[20] ?? 0) ^ 0xff;
    await db
      .update(providerKeys)
      .set({ encryptedPayload: `v1:${raw.toString("base64url")}` })
      .where(eq(providerKeys.id, row.id));

    await expect(
      service.getDecrypted({ environmentId, provider: "twilio" }),
    ).rejects.toBeInstanceOf(CloudDecryptError);
  });

  it("records verification and removal, and reports a missing target", async () => {
    // Re-store the twilio key over the tampered ciphertext, then verify it.
    await service.store({
      organizationId: ORG_ID,
      environmentId,
      provider: "twilio",
      payload: { authToken: "fake_twilio_token_dddd4444" },
    });

    const verified = await service.markVerified({
      environmentId,
      provider: "twilio",
    });
    if (!verified.found) throw new Error("expected the twilio key to exist");
    expect(verified.key.verifiedAt).toBeInstanceOf(Date);

    expect(await service.remove({ environmentId, provider: "twilio" })).toEqual(
      {
        removed: true,
      },
    );
    expect(await service.remove({ environmentId, provider: "twilio" })).toEqual(
      {
        removed: false,
      },
    );
    expect(
      await service.markVerified({ environmentId, provider: "twilio" }),
    ).toEqual({ found: false });
  });

  it("writes an audit row per mutation, with no secret material in it", async () => {
    const rows = await auditRows();
    expect(rows.map((r) => r.action)).toEqual([
      "provider_key.stored", // resend
      "provider_key.verified", // resend
      "provider_key.stored", // resend (replace)
      "provider_key.stored", // twilio
      "provider_key.stored", // twilio (re-store over tampered)
      "provider_key.verified", // twilio
      "provider_key.removed", // twilio
    ]);
    // The explicit actor is recorded; the default fills in elsewhere.
    expect(rows[0]?.actor).toBe("user_test");
    expect(rows[1]?.actor).toBe("system");

    const serialized = JSON.stringify(rows.map((r) => r.detail));
    for (const secret of [
      FIRST_PAYLOAD.apiKey,
      SECOND_PAYLOAD.apiKey,
      "fake_twilio_token",
      // last4 is a real substring of the secret — it must not be in the audit
      // log either, only on the key row the dashboard reads deliberately.
      SECOND_PAYLOAD.apiKey.slice(-4),
      "v1:",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("rejects a malformed input before touching the database", async () => {
    await expect(
      service.store({
        organizationId: ORG_ID,
        environmentId: "not-a-uuid",
        provider: "resend",
        payload: FIRST_PAYLOAD,
      }),
    ).rejects.toThrow();

    await expect(
      service.store({
        organizationId: ORG_ID,
        environmentId,
        provider: "Resend Inc",
        payload: FIRST_PAYLOAD,
      }),
    ).rejects.toThrow();

    await expect(
      service.store({
        organizationId: ORG_ID,
        environmentId,
        provider: "resend",
        payload: {},
      }),
    ).rejects.toThrow();
  });
});
