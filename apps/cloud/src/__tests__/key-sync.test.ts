import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import {
  cloudAuditLog,
  environments,
  organizations,
  providerKeys,
  stacks,
} from "../db/schema";
import { env } from "../env";
import { KeySyncService } from "../services/key-sync";
import {
  buildProviderEnv,
  PROVIDER_ENV_OWNED_NAMES,
  SENDER_IDENTITY_PROVIDER,
} from "../services/provider-env";
import { ProviderKeyService } from "../services/provider-keys";
import type { StackRefs } from "../substrate";
import { FakeSubstrate } from "../substrate";

/**
 * Key sync against the REAL control-plane database and the FakeSubstrate.
 *
 * Only two things are faked, and for the same reason as everywhere else in this
 * app: the SUBSTRATE (that is the seam's purpose) and FETCH — a validator suite
 * that called api.resend.com would need a real credential in the repo and would
 * go red whenever a vendor did.
 *
 * Every credential below is an obvious fake.
 */

const ORG_ID = "key-sync-test-org";
// The tail is deliberately NON-HEX. The audit assertion below asserts the last
// four characters never appear in any detail blob, and that blob is full of
// UUIDs — a hex tail like "1111" turns up inside a random uuid often enough to
// redden the suite for no reason, which is a test that fails at random rather
// than a test that catches a leak.
const RESEND_KEY = "re_fake_key_aaaazqxw";
const TWILIO_TOKEN = "fake_twilio_token_bbbb2222";

const providerKeyService = new ProviderKeyService(db);

/** A fetch that answers every validator with "live, one verified domain". */
function okFetch(domains: string[] = ["acme.test"]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("resend.com")) {
      return new Response(
        JSON.stringify({
          data: domains.map((name) => ({ name, status: "verified" })),
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
}

/** A fetch that refuses everything — the "the tenant pasted a dead key" case. */
const refusingFetch = (async () =>
  new Response(JSON.stringify({ message: "invalid" }), {
    status: 401,
  })) as typeof fetch;

interface Fixture {
  environmentId: string;
  stackId: string;
  refs: StackRefs;
}

/** An environment plus a stack in `status`, already known to the substrate. */
async function seed(
  substrate: FakeSubstrate,
  kind: "production" | "staging" | "test",
  status: "running" | "requested",
): Promise<Fixture> {
  const [environment] = await db
    .insert(environments)
    .values({
      organizationId: ORG_ID,
      name: `${kind}-${randomBytes(4).toString("hex")}`,
      kind,
    })
    .returning();
  if (!environment) throw new Error("fixture environment not created");

  const stackId = randomUUID();
  const refs = await substrate.provisionStack({
    stackId,
    organizationId: ORG_ID,
    environmentName: environment.name,
    region: "us",
    topology: "shared",
    initialImage: "hogsend-default:test",
    env: {},
  });

  await db.insert(stacks).values({
    id: stackId,
    organizationId: ORG_ID,
    environmentId: environment.id,
    status,
    region: "us",
    substrateRefs: { ...refs },
  });

  return { environmentId: environment.id, stackId, refs };
}

function service(substrate: FakeSubstrate, fetchImpl: typeof fetch) {
  return new KeySyncService({
    db,
    substrate,
    fetchImpl,
    providerKeys: providerKeyService,
  });
}

/** The env patches that actually reached the substrate. */
function setEnvCalls(
  substrate: FakeSubstrate,
): Array<Record<string, string | null>> {
  return substrate.calls
    .filter((call) => call.method === "setEnv")
    .map((call) => call.args[1] as Record<string, string | null>);
}

async function keyRows(environmentId: string) {
  return db
    .select()
    .from(providerKeys)
    .where(eq(providerKeys.environmentId, environmentId));
}

async function cleanup(): Promise<void> {
  await db.delete(organizations).where(eq(organizations.id, ORG_ID));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();
  await db
    .insert(organizations)
    .values({ id: ORG_ID, name: "Key Sync Test Org", region: "us" });
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
});

describe("buildProviderEnv", () => {
  it("maps stored payloads onto the env names the engine's plugins read", () => {
    expect(
      buildProviderEnv({
        keys: [
          { provider: "resend", payload: { apiKey: RESEND_KEY } },
          {
            provider: "posthog",
            payload: { apiKey: "phc_fake", personalApiKey: "phx_fake" },
          },
          {
            provider: "twilio",
            payload: { accountSid: "ACfake", authToken: TWILIO_TOKEN },
          },
          {
            provider: SENDER_IDENTITY_PROVIDER,
            payload: { from: "hi@a.test" },
          },
        ],
      }),
    ).toEqual({
      RESEND_API_KEY: RESEND_KEY,
      POSTHOG_API_KEY: "phc_fake",
      POSTHOG_PERSONAL_API_KEY: "phx_fake",
      TWILIO_ACCOUNT_SID: "ACfake",
      TWILIO_AUTH_TOKEN: TWILIO_TOKEN,
      EMAIL_FROM: "hi@a.test",
      EMAIL_DOMAIN: "a.test",
    });
  });

  it("contributes nothing for a provider the engine has no plugin for", () => {
    expect(
      buildProviderEnv({
        keys: [{ provider: "mailchimp", payload: { apiKey: "fake" } }],
      }),
    ).toEqual({});
  });

  it("falls back to the legacy RESEND_FROM_EMAIL for the neutral from-address", () => {
    expect(
      buildProviderEnv({
        keys: [
          {
            provider: "resend",
            payload: { apiKey: RESEND_KEY, fromEmail: "legacy@acme.test" },
          },
        ],
      }),
    ).toMatchObject({
      RESEND_FROM_EMAIL: "legacy@acme.test",
      EMAIL_FROM: "legacy@acme.test",
      EMAIL_DOMAIN: "acme.test",
    });
  });

  it("owns every env name it can write, so a removal can unset them", () => {
    for (const name of ["RESEND_API_KEY", "EMAIL_FROM", "EMAIL_DOMAIN"]) {
      expect(PROVIDER_ENV_OWNED_NAMES).toContain(name);
    }
    // The engine vars the pipeline owns are NOT ours to unset.
    expect(PROVIDER_ENV_OWNED_NAMES).not.toContain("DATABASE_URL");
    expect(PROVIDER_ENV_OWNED_NAMES).not.toContain("HOGSEND_TEST_MODE");
  });
});

describe("KeySyncService.storeAndSync", () => {
  it("stores NOTHING when the provider refuses the key", async () => {
    const substrate = new FakeSubstrate();
    const fixture = await seed(substrate, "production", "running");

    const result = await service(substrate, refusingFetch).storeAndSync({
      organizationId: ORG_ID,
      environmentId: fixture.environmentId,
      provider: "resend",
      payload: { apiKey: RESEND_KEY },
    });

    expect(result).toEqual({
      stored: false,
      reason: "invalid_key",
      detail: "unauthorized",
    });
    // The row is ABSENT — not stored-but-unverified.
    expect(await keyRows(fixture.environmentId)).toHaveLength(0);
    expect(setEnvCalls(substrate)).toHaveLength(0);
  });

  it("stores, verifies and syncs a live key with its sender identity", async () => {
    const substrate = new FakeSubstrate();
    const fixture = await seed(substrate, "production", "running");
    const sync = service(substrate, okFetch(["acme.test"]));

    const result = await sync.storeAndSync({
      organizationId: ORG_ID,
      environmentId: fixture.environmentId,
      provider: "resend",
      payload: { apiKey: RESEND_KEY },
      fromAddress: "hello@acme.test",
      actor: "user_test",
    });

    if (!result.stored) throw new Error(`expected a store: ${result.detail}`);
    expect(result.synced).toBe(true);
    expect(result.key.verifiedAt).toBeInstanceOf(Date);
    expect(result.verifiedDomains).toEqual(["acme.test"]);

    // Both rows: the credential and the sender identity beside it.
    const rows = await keyRows(fixture.environmentId);
    expect(rows.map((r) => r.provider).sort()).toEqual([
      "resend",
      SENDER_IDENTITY_PROVIDER,
    ]);

    // What actually reached the substrate.
    const applied = substrate.snapshot(fixture.refs).env.api;
    expect(applied.RESEND_API_KEY).toBe(RESEND_KEY);
    expect(applied.EMAIL_FROM).toBe("hello@acme.test");
    expect(applied.EMAIL_DOMAIN).toBe("acme.test");
    // A running stack picks up new env only on a restart.
    expect(substrate.calls.filter((c) => c.method === "redeploy")).toHaveLength(
      1,
    );

    // And the trail says WHICH vars moved, never their values.
    const [audit] = await db
      .select()
      .from(cloudAuditLog)
      .where(
        and(
          eq(cloudAuditLog.organizationId, ORG_ID),
          eq(cloudAuditLog.action, "provider_key.synced"),
        ),
      );
    expect(audit?.actor).toBe("user_test");
    expect(audit?.detail).toMatchObject({ provider: "resend" });
    const serialized = JSON.stringify(audit?.detail);
    expect(serialized).toContain("RESEND_API_KEY");
    expect(serialized).not.toContain(RESEND_KEY);
  });

  it("rejects a from-address whose domain the provider has not verified", async () => {
    const substrate = new FakeSubstrate();
    const fixture = await seed(substrate, "production", "running");

    const result = await service(
      substrate,
      okFetch(["acme.test"]),
    ).storeAndSync({
      organizationId: ORG_ID,
      environmentId: fixture.environmentId,
      provider: "resend",
      payload: { apiKey: RESEND_KEY },
      fromAddress: "hello@not-verified.test",
    });

    expect(result).toEqual({
      stored: false,
      reason: "from_domain_unverified",
      detail: "not-verified.test",
    });
    // The KEY was live, but the submission is one unit: nothing is stored.
    expect(await keyRows(fixture.environmentId)).toHaveLength(0);
    expect(setEnvCalls(substrate)).toHaveLength(0);
  });

  it("stores without touching the substrate when the stack is not running", async () => {
    const substrate = new FakeSubstrate();
    const fixture = await seed(substrate, "production", "requested");

    const result = await service(substrate, okFetch()).storeAndSync({
      organizationId: ORG_ID,
      environmentId: fixture.environmentId,
      provider: "resend",
      payload: { apiKey: RESEND_KEY },
    });

    if (!result.stored) throw new Error("expected a store");
    // The pipeline's set-env step will pick it up — calling a stack that is
    // still provisioning would race it.
    expect(result.synced).toBe(false);
    expect(setEnvCalls(substrate)).toHaveLength(0);
    expect(await keyRows(fixture.environmentId)).toHaveLength(1);
  });

  it("keeps HOGSEND_TEST_MODE on for a test-kind environment", async () => {
    const substrate = new FakeSubstrate();
    const fixture = await seed(substrate, "test", "running");

    await service(substrate, okFetch()).storeAndSync({
      organizationId: ORG_ID,
      environmentId: fixture.environmentId,
      provider: "twilio",
      payload: { accountSid: "ACfake", authToken: TWILIO_TOKEN },
    });

    const [vars] = setEnvCalls(substrate);
    expect(vars?.HOGSEND_TEST_MODE).toBe("true");
    expect(substrate.snapshot(fixture.refs).env.worker.TWILIO_AUTH_TOKEN).toBe(
      TWILIO_TOKEN,
    );
  });
});

describe("KeySyncService.removeAndSync", () => {
  it("unsets the removed provider's vars with nulls, and redeploys", async () => {
    const substrate = new FakeSubstrate();
    const fixture = await seed(substrate, "production", "running");
    const sync = service(substrate, okFetch(["acme.test"]));

    await sync.storeAndSync({
      organizationId: ORG_ID,
      environmentId: fixture.environmentId,
      provider: "resend",
      payload: { apiKey: RESEND_KEY },
      fromAddress: "hello@acme.test",
    });
    await sync.storeAndSync({
      organizationId: ORG_ID,
      environmentId: fixture.environmentId,
      provider: "twilio",
      payload: { accountSid: "ACfake", authToken: TWILIO_TOKEN },
    });

    const result = await sync.removeAndSync({
      organizationId: ORG_ID,
      environmentId: fixture.environmentId,
      provider: "twilio",
    });

    expect(result.removed).toBe(true);
    expect(result.synced).toBe(true);
    // The tenant is told what stops working, in words rather than env names.
    expect(result.inert.length).toBeGreaterThan(0);

    const last = setEnvCalls(substrate).at(-1);
    expect(last?.TWILIO_ACCOUNT_SID).toBeNull();
    expect(last?.TWILIO_AUTH_TOKEN).toBeNull();
    // The credentials that REMAIN are re-asserted, not collaterally unset.
    expect(last?.RESEND_API_KEY).toBe(RESEND_KEY);

    const applied = substrate.snapshot(fixture.refs).env.api;
    expect(applied.TWILIO_AUTH_TOKEN).toBeUndefined();
    expect(applied.RESEND_API_KEY).toBe(RESEND_KEY);
    expect(applied.EMAIL_FROM).toBe("hello@acme.test");
  });

  it("unsets the sender identity when it is the row removed", async () => {
    const substrate = new FakeSubstrate();
    const fixture = await seed(substrate, "production", "running");
    const sync = service(substrate, okFetch(["acme.test"]));

    await sync.storeAndSync({
      organizationId: ORG_ID,
      environmentId: fixture.environmentId,
      provider: "resend",
      payload: { apiKey: RESEND_KEY },
      fromAddress: "hello@acme.test",
    });
    await sync.removeAndSync({
      organizationId: ORG_ID,
      environmentId: fixture.environmentId,
      provider: SENDER_IDENTITY_PROVIDER,
    });

    const applied = substrate.snapshot(fixture.refs).env.api;
    expect(applied.EMAIL_FROM).toBeUndefined();
    expect(applied.EMAIL_DOMAIN).toBeUndefined();
    expect(applied.RESEND_API_KEY).toBe(RESEND_KEY);
  });

  it("reports a missing credential without calling the substrate", async () => {
    const substrate = new FakeSubstrate();
    const fixture = await seed(substrate, "production", "running");

    const result = await service(substrate, okFetch()).removeAndSync({
      organizationId: ORG_ID,
      environmentId: fixture.environmentId,
      provider: "postmark",
    });

    expect(result).toMatchObject({ removed: false, synced: false });
    expect(setEnvCalls(substrate)).toHaveLength(0);
  });
});

describe("audit trail", () => {
  it("carries no secret material on any key-sync row", async () => {
    const rows = await db
      .select({ detail: cloudAuditLog.detail })
      .from(cloudAuditLog)
      .where(eq(cloudAuditLog.organizationId, ORG_ID));

    const serialized = JSON.stringify(rows.map((r) => r.detail));
    for (const secret of [
      RESEND_KEY,
      TWILIO_TOKEN,
      RESEND_KEY.slice(-4),
      "v1:",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
