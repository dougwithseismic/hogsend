import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import { environments, organizations, relayTokens } from "../db/schema";
import { env } from "../env";
import {
  hashRelayToken,
  RELAY_TOKEN_PREFIX,
  RelayTokenService,
} from "../services/relay-tokens";

/**
 * The credential the whole relay's tenant isolation rests on.
 *
 * The properties under test are the ones that are invisible in a response body
 * and would therefore survive a green suite if they broke:
 *  - nothing recoverable is stored. A database dump plus the encryption secret
 *    still does not yield a working token;
 *  - the stored hash is KEYED. A plain sha256 of the token would verify exactly
 *    the same way, so only comparing against the unkeyed digest can tell them
 *    apart;
 *  - a rotation makes the previous token stop working IMMEDIATELY, because the
 *    unique index on `environment_id` forces a replace rather than an insert.
 */

const ORG = "relay-token-test-org";
const service = new RelayTokenService(db);

let seq = 0;

async function seedEnvironment(): Promise<string> {
  seq += 1;
  const [row] = await db
    .insert(environments)
    .values({
      organizationId: ORG,
      name: `relay-token-env-${seq}`,
      kind: "test",
    })
    .returning();
  if (!row) throw new Error("failed to seed environment");
  return row.id;
}

async function cleanup(): Promise<void> {
  await db.delete(organizations).where(inArray(organizations.id, [ORG]));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();
  await db
    .insert(organizations)
    .values({ id: ORG, name: "Relay Token Test Org", region: "us" });
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
});

describe("RelayTokenService", () => {
  it("mints a prefixed token and resolves it back to its environment", async () => {
    const environmentId = await seedEnvironment();
    const { token, summary } = await service.mint({ environmentId });

    expect(token.startsWith(RELAY_TOKEN_PREFIX)).toBe(true);
    expect(summary.environmentId).toBe(environmentId);
    expect(summary.last4).toBe(token.slice(-4));

    const verified = await service.verify({ token });
    expect(verified).toEqual({
      found: true,
      environmentId,
      tokenId: summary.id,
    });
  });

  it("stores a KEYED hash, never the token and never a plain sha256", async () => {
    const environmentId = await seedEnvironment();
    const { token } = await service.mint({ environmentId });

    const [row] = await db
      .select()
      .from(relayTokens)
      .where(eq(relayTokens.environmentId, environmentId));
    if (!row) throw new Error("no relay token row");

    expect(row.tokenHash).toBe(hashRelayToken(token));
    // The whole point of the key: an unkeyed digest of the same token is a
    // DIFFERENT value, so a stolen database cannot confirm a guess offline.
    expect(row.tokenHash).not.toBe(
      createHash("sha256").update(token, "utf-8").digest("hex"),
    );
    // Nothing on the row contains the secret itself.
    expect(JSON.stringify(row)).not.toContain(
      token.slice(RELAY_TOKEN_PREFIX.length),
    );
  });

  it("refuses an unknown, malformed or empty token", async () => {
    for (const token of ["", "hsrel_nope", "not-even-close", "x".repeat(600)]) {
      expect(await service.verify({ token })).toEqual({ found: false });
    }
  });

  it("stops accepting the previous token the instant one is rotated", async () => {
    const environmentId = await seedEnvironment();
    const first = await service.mint({ environmentId });
    const second = await service.mint({ environmentId });

    expect(second.token).not.toBe(first.token);
    expect(second.replaced).toBe(true);
    expect(await service.verify({ token: first.token })).toEqual({
      found: false,
    });
    expect(await service.verify({ token: second.token })).toMatchObject({
      found: true,
      environmentId,
    });

    // Replaced, not accumulated: two live tokens would make "revoke" a lie.
    const rows = await db
      .select()
      .from(relayTokens)
      .where(eq(relayTokens.environmentId, environmentId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rotatedAt).not.toBeNull();
  });

  it("keeps two environments' tokens apart", async () => {
    const a = await seedEnvironment();
    const b = await seedEnvironment();
    const tokenA = (await service.mint({ environmentId: a })).token;
    const tokenB = (await service.mint({ environmentId: b })).token;

    expect(await service.verify({ token: tokenA })).toMatchObject({
      environmentId: a,
    });
    expect(await service.verify({ token: tokenB })).toMatchObject({
      environmentId: b,
    });
  });

  it("ensures a token exists without handing one out", async () => {
    const environmentId = await seedEnvironment();

    const created = await service.ensure({ environmentId });
    expect(created.created).toBe(true);
    // `ensure` runs from a page read; a secret that reached a render would be a
    // secret shown more than once.
    expect(created).not.toHaveProperty("token");

    const again = await service.ensure({ environmentId });
    expect(again.created).toBe(false);
    expect(again.summary.id).toBe(created.summary.id);
  });
});
