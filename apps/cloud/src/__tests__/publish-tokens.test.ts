import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import {
  cells,
  cloudAuditLog,
  environments,
  organizations,
  publishTokens,
} from "../db/schema";
import { env } from "../env";
import { NotFoundError } from "../services/errors";
import { OrgService } from "../services/orgs";
import {
  hashPublishToken,
  PUBLISH_TOKEN_PREFIX,
  PublishTokenService,
} from "../services/publish-tokens";

/**
 * Against a REAL database: "one live token per environment" is a unique index
 * and "a rotation replaces" is an upsert against it, so both are Postgres'
 * answers rather than this service's intention.
 *
 * The property that matters most is negative — the plaintext token must appear
 * NOWHERE in the row, so the tests assert on the stored columns directly.
 */
const CELL = "publish-tokens-test-us-1";
const ORG = "publish-tokens-test-org";
const SIGNUP_ORG = "publish-tokens-signup-org";

const service = new PublishTokenService(db);
const orgs = new OrgService(db);

let seq = 0;

async function seedEnvironment(): Promise<string> {
  seq += 1;
  const [row] = await db
    .insert(environments)
    .values({ organizationId: ORG, name: `token-env-${seq}`, kind: "test" })
    .returning();
  if (!row) throw new Error("failed to seed environment");
  return row.id;
}

async function readToken(environmentId: string) {
  const [row] = await db
    .select()
    .from(publishTokens)
    .where(eq(publishTokens.environmentId, environmentId));
  return row ?? null;
}

async function auditFor(subject: string) {
  return db
    .select()
    .from(cloudAuditLog)
    .where(eq(cloudAuditLog.subject, subject))
    .orderBy(cloudAuditLog.createdAt);
}

async function cleanup(): Promise<void> {
  await db
    .delete(organizations)
    .where(inArray(organizations.id, [ORG, SIGNUP_ORG]));
  await db.delete(cells).where(eq(cells.name, CELL));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();
  await db.insert(cells).values({
    name: CELL,
    region: "us",
    sharedClusterDsn: "v1:fake-dsn",
    sharedHatchetUrl: "http://hatchet.test:7077",
    maxTenants: 50,
  });
  await db
    .insert(organizations)
    .values({ id: ORG, name: "Publish Tokens Test Org", region: "us" });
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
});

describe("PublishTokenService.mint", () => {
  it("returns a prefixed token and stores only its hash", async () => {
    const environmentId = await seedEnvironment();
    const { token, summary, replaced } = await service.mint({
      environmentId,
      actor: "user_1",
    });

    expect(token.startsWith(PUBLISH_TOKEN_PREFIX)).toBe(true);
    // 32 bytes of entropy, base64url: 43 characters after the prefix.
    expect(token.length).toBeGreaterThan(PUBLISH_TOKEN_PREFIX.length + 40);
    expect(replaced).toBe(false);

    const row = await readToken(environmentId);
    if (!row) throw new Error("no token row");
    // The secret is NOWHERE in the row.
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.tokenHash).toBe(hashPublishToken(token));
    expect(row.tokenHash).not.toBe(token);
    expect(row.last4).toBe(token.slice(-4));
    expect(summary).not.toHaveProperty("tokenHash");
  });

  it("issues a different token every time", async () => {
    const a = await service.mint({ environmentId: await seedEnvironment() });
    const b = await service.mint({ environmentId: await seedEnvironment() });
    expect(a.token).not.toBe(b.token);
  });

  it("audits the mint without any part of the secret", async () => {
    const environmentId = await seedEnvironment();
    const { token, summary } = await service.mint({
      environmentId,
      actor: "user_1",
    });

    const rows = await auditFor(summary.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("publish_token.minted");
    expect(rows[0]?.organizationId).toBe(ORG);
    const detail = JSON.stringify(rows[0]?.detail);
    expect(detail).not.toContain(token);
    expect(detail).not.toContain(token.slice(-4));
  });

  it("refuses an environment that does not exist", async () => {
    await expect(
      service.mint({ environmentId: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("PublishTokenService.rotate", () => {
  it("replaces the token, invalidating the old one immediately", async () => {
    const environmentId = await seedEnvironment();
    const first = await service.mint({ environmentId });

    const second = await service.rotate({ environmentId, actor: "user_1" });
    expect(second.token).not.toBe(first.token);
    expect(second.replaced).toBe(true);
    expect(second.summary.rotatedAt).toBeInstanceOf(Date);

    // Exactly one row survives, and it is the new one.
    const rows = await db
      .select()
      .from(publishTokens)
      .where(eq(publishTokens.environmentId, environmentId));
    expect(rows).toHaveLength(1);

    expect((await service.verify({ token: first.token })).found).toBe(false);
    expect(await service.verify({ token: second.token })).toMatchObject({
      found: true,
      environmentId,
    });
  });

  it("audits a rotation as a rotation", async () => {
    const environmentId = await seedEnvironment();
    await service.mint({ environmentId });
    const rotated = await service.rotate({ environmentId });

    const actions = (await auditFor(rotated.summary.id)).map((r) => r.action);
    expect(actions).toEqual(["publish_token.minted", "publish_token.rotated"]);
  });

  it("refuses when there is no token to rotate", async () => {
    const environmentId = await seedEnvironment();
    await db
      .delete(publishTokens)
      .where(eq(publishTokens.environmentId, environmentId));
    await expect(service.rotate({ environmentId })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("PublishTokenService.verify", () => {
  it("answers with the environment the token belongs to", async () => {
    const environmentId = await seedEnvironment();
    const { token } = await service.mint({ environmentId });

    expect(await service.verify({ token })).toMatchObject({
      found: true,
      environmentId,
    });
  });

  it("refuses a token from another environment as simply not this one", async () => {
    const a = await seedEnvironment();
    const b = await seedEnvironment();
    const first = await service.mint({ environmentId: a });
    await service.mint({ environmentId: b });

    const verified = await service.verify({ token: first.token });
    expect(verified).toMatchObject({ found: true, environmentId: a });
    // The caller — the route — is what compares it to the target.
    expect(verified.found && verified.environmentId === b).toBe(false);
  });

  it("refuses garbage, a hash presented as a token, and an oversized string", async () => {
    const environmentId = await seedEnvironment();
    const { token } = await service.mint({ environmentId });

    expect(await service.verify({ token: "" })).toEqual({ found: false });
    expect(await service.verify({ token: "hspub_nope" })).toEqual({
      found: false,
    });
    // Knowing the stored hash must not be enough to authenticate.
    expect(await service.verify({ token: hashPublishToken(token) })).toEqual({
      found: false,
    });
    expect(await service.verify({ token: "x".repeat(5000) })).toEqual({
      found: false,
    });
  });
});

describe("PublishTokenService.ensure", () => {
  it("mints once for an environment that has none, and is idempotent after", async () => {
    const environmentId = await seedEnvironment();
    await db
      .delete(publishTokens)
      .where(eq(publishTokens.environmentId, environmentId));

    const first = await service.ensure({ environmentId });
    expect(first.created).toBe(true);

    const second = await service.ensure({ environmentId });
    expect(second.created).toBe(false);
    expect(second.summary.id).toBe(first.summary.id);

    // Concurrent page loads must not each mint one.
    const races = await Promise.all([
      service.ensure({ environmentId }),
      service.ensure({ environmentId }),
      service.ensure({ environmentId }),
    ]);
    expect(new Set(races.map((r) => r.summary.id)).size).toBe(1);
  });

  it("never hands back a secret", async () => {
    const environmentId = await seedEnvironment();
    await db
      .delete(publishTokens)
      .where(eq(publishTokens.environmentId, environmentId));
    const result = await service.ensure({ environmentId });
    expect(result).not.toHaveProperty("token");
  });
});

describe("environment creation", () => {
  it("mints a publish token for every environment it creates", async () => {
    const created = await orgs.create({
      id: SIGNUP_ORG,
      name: "Signup Org",
      region: "us",
    });

    const row = await readToken(created.environment.id);
    expect(row).not.toBeNull();
    expect(row?.last4).toHaveLength(4);
    expect(row?.rotatedAt).toBeNull();
    // The token minted at birth is retained by nobody: `get` is metadata only.
    expect(
      await service.get({ environmentId: created.environment.id }),
    ).toMatchObject({ environmentId: created.environment.id });
  });
});
