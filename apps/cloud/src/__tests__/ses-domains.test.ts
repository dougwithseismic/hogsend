import { createPrivateKey, createPublicKey } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as returnPathRoute } from "@/app/api/email/domains/return-path/route";
import {
  POST as createRoute,
  GET as getRoute,
} from "@/app/api/email/domains/route";
import { POST as verifyRoute } from "@/app/api/email/domains/verify/route";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import {
  cloudAuditLog,
  environments,
  organizations,
  providerKeys,
} from "../db/schema";
import { env } from "../env";
import {
  EMAIL_DOMAINS_BURST_LIMIT,
  EMAIL_DOMAINS_WINDOW_MS,
  emailDomainsBucket,
  handleDomainCreate,
  handleDomainGet,
  handleDomainReturnPath,
  handleDomainVerify,
} from "../lib/email-domains";
import { consumeRateLimit } from "../lib/rate-limit";
import {
  DKIM_KEY_BITS,
  dkimRecordHost,
  generateDkimKeypair,
  HOGSEND_DKIM_SELECTOR,
  MAIL_FROM_SPF_VALUE,
  normalizeDomain,
} from "../lib/sending-domains";
import {
  HOGSEND_DKIM_PROVIDER,
  readDkimKey,
  writeDkimKey,
} from "../services/ses-dkim-keys";
import { createHogsendDomains, REDACTED_KEY } from "../services/ses-domains";
import { provisionSesTenant } from "../services/ses-tenants";
import { FakeSesClient } from "../ses/fake";
import { getFakeSesClient, resetSesClients } from "../ses/index";
import { sesTenantName } from "../ses/names";
import { SesError } from "../ses/types";

/**
 * The sending-domain capability (PRD 07), against the deterministic Fake.
 * Nothing here reaches AWS.
 *
 * Three properties carry this suite, and each of them fails INVISIBLY:
 *
 *  - **exactly ONE record in the default flow.** "We accidentally shipped three
 *    records like Resend" would erase the entire competitive point of this PRD
 *    and every assertion about the DKIM record being *present* would still
 *    pass. So the COUNT is asserted, not the membership;
 *  - **2048 bits.** Resend signs with 1024. A keypair generated at the wrong
 *    length verifies, signs, and delivers — the difference only shows up in a
 *    third party's DKIM report. So the modulus is read back off the stored key;
 *  - **the private key never escapes.** A leak into a response body or an audit
 *    row would be invisible until somebody read a log. So every response and
 *    every audit row this suite produces is SCANNED for the key material, after
 *    asserting the key material is non-empty — a scan for an empty needle
 *    passes vacuously and certifies nothing.
 */

const ORG = "ses-domains-test-org";
const DOMAIN = "acme-domains.test";

let seq = 0;

interface Fixture {
  environmentId: string;
  ses: FakeSesClient;
  tenantName: string;
}

/**
 * A fully provisioned environment: an SES tenancy, a configuration set and a
 * relay token, minted the way the pipeline mints them rather than inserted by
 * hand — so a change to provisioning that broke the domains flow shows up here.
 */
async function seed(): Promise<Fixture> {
  seq += 1;
  const [row] = await db
    .insert(environments)
    .values({ organizationId: ORG, name: `ses-domains-${seq}`, kind: "test" })
    .returning();
  if (!row) throw new Error("failed to seed environment");

  const ses = new FakeSesClient({ region: "us" });
  await provisionSesTenant(
    { environmentId: row.id },
    { ses, snsTopicArn: null },
  );
  return { environmentId: row.id, ses, tenantName: sesTenantName(row.id) };
}

function domains(fixture: Fixture) {
  return createHogsendDomains(
    { environmentId: fixture.environmentId },
    { db, ses: fixture.ses },
  );
}

/** The stored private key, read back through the ONE module that can. */
async function storedKey(fixture: Fixture, domain = DOMAIN) {
  return readDkimKey({ environmentId: fixture.environmentId, domain }, { db });
}

/** RSA modulus length of a base64 DER key, in bits. */
function modulusBits(base64Der: string, kind: "private" | "public"): number {
  const der = Buffer.from(base64Der, "base64");
  const key =
    kind === "private"
      ? createPrivateKey({ key: der, format: "der", type: "pkcs8" })
      : createPublicKey({ key: der, format: "der", type: "spki" });
  const { modulusLength } = key.asymmetricKeyDetails ?? {};
  if (typeof modulusLength !== "number") {
    throw new Error("key has no modulus length");
  }
  return modulusLength;
}

async function auditRows(action?: string) {
  const rows = await db
    .select()
    .from(cloudAuditLog)
    .where(eq(cloudAuditLog.organizationId, ORG));
  return action ? rows.filter((row) => row.action === action) : rows;
}

async function cleanup(): Promise<void> {
  await db.delete(organizations).where(inArray(organizations.id, [ORG]));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();
  await db
    .insert(organizations)
    .values({ id: ORG, name: "SES Domains Test Org", region: "us" });
});

afterAll(async () => {
  await cleanup();
  resetSesClients();
  await sqlClient.end();
});

// ---------------------------------------------------------------------------

describe("the DKIM keypair", () => {
  it("is 2048-bit RSA, where Resend signs with 1024", () => {
    const keypair = generateDkimKeypair();
    expect(DKIM_KEY_BITS).toBe(2048);
    expect(modulusBits(keypair.privateKey, "private")).toBe(2048);
    expect(modulusBits(keypair.publicKey, "public")).toBe(2048);
  });

  it("is single-line base64 — no PEM armour, no newlines", () => {
    const keypair = generateDkimKeypair();
    for (const half of [keypair.privateKey, keypair.publicKey]) {
      expect(half).not.toContain("-----BEGIN");
      expect(half).not.toContain("\n");
      expect(half).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    }
    expect(keypair.selector).toBe(HOGSEND_DKIM_SELECTOR);
  });
});

describe("normalizeDomain", () => {
  it("lowercases, trims and drops a trailing dot", () => {
    expect(normalizeDomain("  ACME.Test. ")).toBe("acme.test");
  });

  it("refuses anything that is not a domain", () => {
    for (const bad of [
      "",
      "acme",
      "acme@test.com",
      "-acme.test",
      "http://a.b",
    ]) {
      expect(normalizeDomain(bad)).toBeNull();
    }
  });
});

describe("create", () => {
  it("returns EXACTLY ONE record: the DKIM TXT and nothing else", async () => {
    const fixture = await seed();
    const status = await domains(fixture).create(DOMAIN);

    // THE assertion of this PRD. Resend asks for three; three here would be a
    // silent regression that every other assertion in this file survives.
    expect(status.records).toHaveLength(1);

    const [record] = status.records;
    expect(record).toBeDefined();
    expect(record?.type).toBe("TXT");
    expect(record?.name).toBe(dkimRecordHost(DOMAIN));
    expect(record?.purpose).toBe("dkim");
    expect(record?.status).toBe("pending");
    expect(status.state).toBe("pending");
    expect(status.providerId).toBe("hogsend");
    expect(status.domain).toBe(DOMAIN);
    expect(Date.parse(status.checkedAt)).not.toBeNaN();
  });

  it("publishes the p= public key that matches the stored private key", async () => {
    const fixture = await seed();
    const status = await domains(fixture).create(DOMAIN);
    const key = await storedKey(fixture);

    expect(key).not.toBeNull();
    expect(status.records[0]?.value).toBe(`p=${key?.publicKey}`);
    expect(status.records[0]?.value.startsWith("p=")).toBe(true);
    // The published half really is the public half of the stored private one.
    const derived = createPublicKey(
      createPrivateKey({
        key: Buffer.from(key?.privateKey ?? "", "base64"),
        format: "der",
        type: "pkcs8",
      }),
    )
      .export({ format: "der", type: "spki" })
      .toString("base64");
    expect(key?.publicKey).toBe(derived);
  });

  it("stores a 2048-bit key encrypted, with the selector alongside", async () => {
    const fixture = await seed();
    await domains(fixture).create(DOMAIN);

    const key = await storedKey(fixture);
    expect(key?.selector).toBe("hogsend");
    expect(modulusBits(key?.privateKey ?? "", "private")).toBe(2048);

    const [row] = await db
      .select()
      .from(providerKeys)
      .where(
        and(
          eq(providerKeys.environmentId, fixture.environmentId),
          eq(providerKeys.provider, HOGSEND_DKIM_PROVIDER),
        ),
      );
    expect(row).toBeDefined();
    // Ciphertext only, and no display tail derived from a private key.
    expect(row?.encryptedPayload.startsWith("v1:")).toBe(true);
    expect(row?.encryptedPayload).not.toContain(key?.privateKey ?? "never");
    expect(row?.last4).toBeNull();
  });

  it("calls CreateEmailIdentity with the BYODKIM signing attributes", async () => {
    const fixture = await seed();
    await domains(fixture).create(DOMAIN);
    const key = await storedKey(fixture);

    const call = fixture.ses.calls.find((c) => c.method === "createIdentity");
    expect(call).toBeDefined();
    expect(call?.args[0]).toMatchObject({
      domain: DOMAIN,
      dkim: { selector: "hogsend", privateKey: key?.privateKey },
    });

    // BYODKIM, so SES issues no Easy DKIM CNAME tokens at all: `tokens` comes
    // back carrying OUR SELECTOR, echoed — "this object contains the selector
    // for the public key" (SESv2 API Reference, `DkimAttributes`), confirmed
    // live on 2026-08-11. It implies no second DNS record, which is why the
    // record COUNT assertions elsewhere in this file still read 1.
    const identity = await fixture.ses.getIdentity({ identity: DOMAIN });
    expect(identity.dkim.origin).toBe("EXTERNAL");
    expect(identity.dkim.tokens).toEqual(["hogsend"]);
  });

  it("associates the identity with the environment's SES tenant", async () => {
    const fixture = await seed();
    await domains(fixture).create(DOMAIN);

    const associations = fixture.ses.calls
      .filter((c) => c.method === "associateResource")
      .map((c) => c.args[0] as { tenantName: string; resourceArn: string });
    expect(
      associations.some(
        (a) =>
          a.tenantName === fixture.tenantName &&
          a.resourceArn.endsWith(`identity/${DOMAIN}`),
      ),
    ).toBe(true);

    // The Fake refuses a send from an identity that is not associated, so this
    // is the difference between a domain that can send and one that cannot.
    await fixture.ses.__verifyIdentity(DOMAIN);
    await expect(
      fixture.ses.sendEmail({
        tenantName: fixture.tenantName,
        message: {
          from: `hello@${DOMAIN}`,
          to: ["person@example.test"],
          subject: "hi",
          html: "<p>hi</p>",
        },
      }),
    ).resolves.toMatchObject({ messageId: expect.any(String) });
  });

  it("falls through to a lookup on an existing domain and mints no second keypair", async () => {
    const fixture = await seed();
    const first = await domains(fixture).create(DOMAIN);
    const firstKey = await storedKey(fixture);

    const second = await domains(fixture).create(DOMAIN);

    expect(second.records).toHaveLength(1);
    expect(second.records[0]?.value).toBe(first.records[0]?.value);
    // The published record cannot change: a customer may already have it in
    // their zone, and a second keypair would silently invalidate it.
    expect((await storedKey(fixture))?.privateKey).toBe(firstKey?.privateKey);
    expect(
      fixture.ses.calls.filter((c) => c.method === "createIdentity"),
    ).toHaveLength(1);
  });

  it("reuses the stored key when SES lost the identity", async () => {
    const fixture = await seed();
    await domains(fixture).create(DOMAIN);
    const original = await storedKey(fixture);

    await fixture.ses.deleteIdentity({ identity: DOMAIN });
    const again = await domains(fixture).create(DOMAIN);

    expect((await storedKey(fixture))?.privateKey).toBe(original?.privateKey);
    expect(again.records[0]?.value).toBe(`p=${original?.publicKey}`);
  });

  it("refuses a string that is not a domain", async () => {
    const fixture = await seed();
    await expect(domains(fixture).create("not a domain")).rejects.toMatchObject(
      { code: "invalid_domain" },
    );
  });

  it("refuses an environment with no SES tenancy", async () => {
    seq += 1;
    const [row] = await db
      .insert(environments)
      .values({
        organizationId: ORG,
        name: `ses-domains-bare-${seq}`,
        kind: "test",
      })
      .returning();
    if (!row) throw new Error("failed to seed environment");

    const bare = createHogsendDomains(
      { environmentId: row.id },
      { db, ses: new FakeSesClient({ region: "us" }) },
    );
    await expect(bare.create(DOMAIN)).rejects.toMatchObject({
      code: "email_not_provisioned",
    });
  });
});

describe("get / records / verify", () => {
  it("answers null for a domain SES does not know", async () => {
    const fixture = await seed();
    expect(await domains(fixture).get(DOMAIN)).toBeNull();
  });

  it("answers [] records and a not_found state before the domain is created", async () => {
    const fixture = await seed();
    expect(await domains(fixture).records(DOMAIN)).toEqual([]);

    const status = await domains(fixture).verify(DOMAIN);
    expect(status.state).toBe("not_found");
    expect(status.records).toEqual([]);
  });

  it("reports verified once SES reports SUCCESS/EXTERNAL/signing-enabled", async () => {
    const fixture = await seed();
    await domains(fixture).create(DOMAIN);
    expect((await domains(fixture).get(DOMAIN))?.state).toBe("pending");

    fixture.ses.__verifyIdentity(DOMAIN);

    const status = await domains(fixture).verify(DOMAIN);
    expect(status.state).toBe("verified");
    expect(status.records).toHaveLength(1);
    expect(status.records[0]?.status).toBe("verified");
  });

  it("does NOT report verified when DKIM is not our own EXTERNAL key", async () => {
    const fixture = await seed();
    // Easy DKIM, created out of band — verified for SENDING, but not by the key
    // this stack published, and `records` has nothing to show for it.
    await fixture.ses.createIdentity({ domain: DOMAIN });
    fixture.ses.__verifyIdentity(DOMAIN);

    const status = await domains(fixture).verify(DOMAIN);
    expect(status.state).toBe("pending");
    expect(status.records).toEqual([]);
  });

  it("reports failed when SES gave up on the domain", async () => {
    const fixture = await seed();
    await domains(fixture).create(DOMAIN);
    fixture.ses.__failIdentity(DOMAIN);

    const status = await domains(fixture).verify(DOMAIN);
    expect(status.state).toBe("failed");
    expect(status.records[0]?.status).toBe("failed");
  });
});

describe("the branded return path", () => {
  it("adds EXACTLY TWO records when switched on, and reverts when switched off", async () => {
    const fixture = await seed();
    await domains(fixture).create(DOMAIN);

    const on = await domains(fixture).setReturnPath({
      domain: DOMAIN,
      enabled: true,
    });
    expect(on.enabled).toBe(true);
    expect(on.mailFromDomain).toBe(`send.${DOMAIN}`);
    expect(on.status.records).toHaveLength(3);

    const mx = on.status.records.find((r) => r.type === "MX");
    expect(mx).toEqual({
      type: "MX",
      name: `send.${DOMAIN}`,
      value: "feedback-smtp.us-east-1.amazonses.com",
      priority: 10,
      purpose: "mx",
      status: "pending",
    });

    const spf = on.status.records.find((r) => r.purpose === "spf");
    expect(spf).toEqual({
      type: "TXT",
      name: `send.${DOMAIN}`,
      value: MAIL_FROM_SPF_VALUE,
      purpose: "spf",
      status: "pending",
    });

    // …and BOTH directions. Off is not merely "we stopped adding them".
    const off = await domains(fixture).setReturnPath({
      domain: DOMAIN,
      enabled: false,
    });
    expect(off.enabled).toBe(false);
    expect(off.mailFromDomain).toBeNull();
    expect(off.status.records).toHaveLength(1);
    expect(off.status.records[0]?.purpose).toBe("dkim");
  });

  it("never sets REJECT_MESSAGE — a broken MX must not become an outage", async () => {
    const fixture = await seed();
    await domains(fixture).create(DOMAIN);
    await domains(fixture).setReturnPath({ domain: DOMAIN, enabled: true });
    await domains(fixture).setReturnPath({ domain: DOMAIN, enabled: false });

    const behaviours = fixture.ses.calls
      .filter((c) => c.method === "setMailFrom")
      .map(
        (c) =>
          (c.args[0] as { behaviorOnMxFailure?: string }).behaviorOnMxFailure,
      );
    expect(behaviours).toEqual(["USE_DEFAULT_VALUE", "USE_DEFAULT_VALUE"]);
    expect(behaviours).not.toContain("REJECT_MESSAGE");
  });

  it("marks the MX and SPF verified once the return path resolves", async () => {
    const fixture = await seed();
    await domains(fixture).create(DOMAIN);
    await domains(fixture).setReturnPath({ domain: DOMAIN, enabled: true });
    fixture.ses.__verifyMailFrom(DOMAIN);

    const status = await domains(fixture).verify(DOMAIN);
    expect(status.records.filter((r) => r.status === "verified")).toHaveLength(
      2,
    );
  });

  it("refuses to toggle a domain that was never created", async () => {
    const fixture = await seed();
    await expect(
      domains(fixture).setReturnPath({ domain: DOMAIN, enabled: true }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(fixture.ses.calls.some((c) => c.method === "setMailFrom")).toBe(
      false,
    );
  });
});

describe("purpose", () => {
  it("is correct on every record, so CLI dns-apply needs no special case", async () => {
    const fixture = await seed();
    await domains(fixture).create(DOMAIN);
    const { status } = await domains(fixture).setReturnPath({
      domain: DOMAIN,
      enabled: true,
    });

    expect(status.records.map((r) => `${r.type}:${r.purpose}`).sort()).toEqual([
      "MX:mx",
      "TXT:dkim",
      "TXT:spf",
    ]);
    // A record with no purpose (or the `other` fallback) is what would force a
    // special case into the CLI's writer.
    for (const record of status.records) {
      expect(["dkim", "mx", "spf"]).toContain(record.purpose);
    }
  });
});

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

function url(path: string): string {
  return `http://localhost:3004/api/email/domains${path}`;
}

function request(
  path: string,
  options: { token?: string; method?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  return new Request(url(path), {
    method: options.method ?? "POST",
    headers,
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
}

/** A provisioned environment plus the relay token its instance would hold. */
async function seedWithToken(
  client?: FakeSesClient,
): Promise<Fixture & { token: string }> {
  seq += 1;
  const [row] = await db
    .insert(environments)
    .values({
      organizationId: ORG,
      name: `ses-domains-route-${seq}`,
      kind: "test",
    })
    .returning();
  if (!row) throw new Error("failed to seed environment");

  const ses = client ?? new FakeSesClient({ region: "us" });
  const provisioned = await provisionSesTenant(
    { environmentId: row.id },
    { ses, snsTopicArn: null },
  );
  return {
    environmentId: row.id,
    ses,
    tenantName: sesTenantName(row.id),
    token: provisioned.relayToken,
  };
}

describe("the control-plane endpoints", () => {
  it("refuse an anonymous caller", async () => {
    const response = await handleDomainCreate(
      request("", { body: { domain: DOMAIN } }),
      { db },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "missing_token" });
  });

  it("refuse a token that is not valid", async () => {
    const response = await handleDomainCreate(
      request("", { token: "hsrel_nope", body: { domain: DOMAIN } }),
      { db },
    );
    expect(response.status).toBe(401);
  });

  it("create, read and verify a domain over the relay token", async () => {
    const fixture = await seedWithToken();

    const created = await handleDomainCreate(
      request("", { token: fixture.token, body: { domain: DOMAIN } }),
      { db, ses: fixture.ses },
    );
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as {
      status: { records: unknown[]; state: string };
    };
    expect(createdBody.status.records).toHaveLength(1);
    expect(createdBody.status.state).toBe("pending");

    const read = await handleDomainGet(
      new Request(url(`?domain=${DOMAIN}`), {
        method: "GET",
        headers: { authorization: `Bearer ${fixture.token}` },
      }),
      { db, ses: fixture.ses },
    );
    expect(read.status).toBe(200);
    expect((await read.json()) as { status: unknown }).toMatchObject({
      status: { domain: DOMAIN },
    });

    fixture.ses.__verifyIdentity(DOMAIN);
    const verified = await handleDomainVerify(
      request("/verify", { token: fixture.token, body: { domain: DOMAIN } }),
      { db, ses: fixture.ses },
    );
    expect(
      (await verified.json()) as { status: { state: string } },
    ).toMatchObject({ status: { state: "verified" } });
  });

  it("answer a null status for a domain SES does not know", async () => {
    const fixture = await seedWithToken();
    const response = await handleDomainGet(
      new Request(url(`?domain=${DOMAIN}`), {
        method: "GET",
        headers: { authorization: `Bearer ${fixture.token}` },
      }),
      { db, ses: fixture.ses },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: null });
  });

  it("toggle the branded return path in both directions", async () => {
    const fixture = await seedWithToken();
    await handleDomainCreate(
      request("", { token: fixture.token, body: { domain: DOMAIN } }),
      { db, ses: fixture.ses },
    );

    const on = await handleDomainReturnPath(
      request("/return-path", {
        token: fixture.token,
        body: { domain: DOMAIN, enabled: true },
      }),
      { db, ses: fixture.ses },
    );
    expect(
      (await on.json()) as { enabled: boolean; status: { records: unknown[] } },
    ).toMatchObject({ enabled: true, status: { records: expect.any(Array) } });

    const off = await handleDomainReturnPath(
      request("/return-path", {
        token: fixture.token,
        body: { domain: DOMAIN, enabled: false },
      }),
      { db, ses: fixture.ses },
    );
    const offBody = (await off.json()) as {
      enabled: boolean;
      status: { records: unknown[] };
    };
    expect(offBody.enabled).toBe(false);
    expect(offBody.status.records).toHaveLength(1);
  });

  it("refuse a body that names anything but the domain", async () => {
    const fixture = await seedWithToken();
    const response = await handleDomainCreate(
      request("", {
        token: fixture.token,
        // A caller must not be able to choose its own environment or tenant.
        body: { domain: DOMAIN, environmentId: "somebody-else" },
      }),
      { db, ses: fixture.ses },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
  });

  it("answer 400 for a domain that is not a domain", async () => {
    const fixture = await seedWithToken();
    const response = await handleDomainCreate(
      request("", { token: fixture.token, body: { domain: "not a domain" } }),
      { db, ses: fixture.ses },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_domain" });
  });

  it("answer 404 when the toggle names an identity that is not there", async () => {
    const fixture = await seedWithToken();
    const response = await handleDomainReturnPath(
      request("/return-path", {
        token: fixture.token,
        body: { domain: DOMAIN, enabled: true },
      }),
      { db, ses: fixture.ses },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "not_found" });
  });

  it("bound the burst, so a leaked token cannot mint keypairs in a loop", async () => {
    const fixture = await seedWithToken();
    const now = new Date();
    await consumeRateLimit({
      bucket: emailDomainsBucket(fixture.environmentId),
      limit: EMAIL_DOMAINS_BURST_LIMIT,
      windowMs: EMAIL_DOMAINS_WINDOW_MS,
      cost: EMAIL_DOMAINS_BURST_LIMIT,
      now,
      db,
    });

    const response = await handleDomainCreate(
      request("", { token: fixture.token, body: { domain: DOMAIN } }),
      { db, ses: fixture.ses, now },
    );
    expect(response.status).toBe(429);
    // And nothing was generated or dialled.
    expect(fixture.ses.calls.some((c) => c.method === "createIdentity")).toBe(
      false,
    );
  });

  it("are wired to the route handlers", async () => {
    // The route resolves the PROCESS-WIDE client rather than an injected one,
    // so this environment is provisioned against that same instance. It is the
    // Fake here because the suite runs with no AWS credentials.
    resetSesClients();
    const fixture = await seedWithToken(getFakeSesClient("us"));

    const created = await createRoute(
      request("", { token: fixture.token, body: { domain: DOMAIN } }),
    );
    expect(created.status).toBe(200);
    expect(
      ((await created.json()) as { status: { records: unknown[] } }).status
        .records,
    ).toHaveLength(1);

    const read = await getRoute(
      new Request(url(`?domain=${DOMAIN}`), {
        method: "GET",
        headers: { authorization: `Bearer ${fixture.token}` },
      }),
    );
    expect(read.status).toBe(200);

    const verified = await verifyRoute(
      request("/verify", { token: fixture.token, body: { domain: DOMAIN } }),
    );
    expect(verified.status).toBe(200);

    const toggled = await returnPathRoute(
      request("/return-path", {
        token: fixture.token,
        body: { domain: DOMAIN, enabled: true },
      }),
    );
    expect(toggled.status).toBe(200);
    resetSesClients();
  });
});

// ---------------------------------------------------------------------------

describe("the private key", () => {
  it("never reaches a response, an audit row, or a log line", async () => {
    const fixture = await seedWithToken();
    const bodies: string[] = [];
    const logged: string[] = [];

    const sinks = ["log", "info", "warn", "error", "debug"] as const;
    const originals = sinks.map((name) => [name, console[name]] as const);
    for (const name of sinks) {
      console[name] = (...args: unknown[]) => {
        logged.push(args.map((a) => String(a)).join(" "));
      };
    }

    try {
      const calls: Promise<Response>[] = [];
      calls.push(
        handleDomainCreate(
          request("", { token: fixture.token, body: { domain: DOMAIN } }),
          { db, ses: fixture.ses },
        ),
      );
      for (const response of await Promise.all(calls)) {
        bodies.push(await response.text());
      }

      for (const [path, body] of [
        ["/verify", { domain: DOMAIN }],
        ["/return-path", { domain: DOMAIN, enabled: true }],
        ["/return-path", { domain: DOMAIN, enabled: false }],
      ] as const) {
        const handler =
          path === "/verify" ? handleDomainVerify : handleDomainReturnPath;
        const response = await handler(
          request(path, { token: fixture.token, body }),
          { db, ses: fixture.ses },
        );
        bodies.push(await response.text());
      }

      const read = await handleDomainGet(
        new Request(url(`?domain=${DOMAIN}`), {
          method: "GET",
          headers: { authorization: `Bearer ${fixture.token}` },
        }),
        { db, ses: fixture.ses },
      );
      bodies.push(await read.text());
    } finally {
      for (const [name, original] of originals) {
        console[name] = original;
      }
    }

    const key = await storedKey(fixture);
    const privateKey = key?.privateKey ?? "";

    // NOT VACUOUS. A scan for an empty needle passes against anything, so the
    // needle is proved real first: it exists, it is long, and it is a key.
    expect(privateKey.length).toBeGreaterThan(1000);
    expect(modulusBits(privateKey, "private")).toBe(2048);

    // The public half really is in the responses — so the scan below is looking
    // at payloads that DO carry key-shaped material, and its silence means
    // something.
    expect(bodies.join("\n")).toContain(key?.publicKey ?? "never");

    for (const body of bodies) {
      expect(body).not.toContain(privateKey);
    }
    for (const line of logged) {
      expect(line).not.toContain(privateKey);
    }
    for (const row of await auditRows()) {
      expect(JSON.stringify(row.detail)).not.toContain(privateKey);
    }
  });

  it("is redacted out of a rejection SES quoted it back in", async () => {
    const fixture = await seedWithToken();
    // Pre-seed the key so the failure below can be scripted to contain it.
    // `CreateEmailIdentity` is the ONE call that puts the key on the wire, so
    // its rejection is the one place AWS could echo it — and the seam keeps the
    // response body verbatim, which is what makes this reachable at all.
    const keypair = generateDkimKeypair();
    await writeDkimKey(
      { environmentId: fixture.environmentId, domain: DOMAIN, keypair },
      { db },
    );
    fixture.ses.failNext(
      "createIdentity",
      new SesError(`BadRequestException: bad key ${keypair.privateKey}`, {
        kind: "invalid",
        detail: `{"message":"bad key ${keypair.privateKey}"}`,
      }),
    );

    const response = await handleDomainCreate(
      request("", { token: fixture.token, body: { domain: DOMAIN } }),
      { db, ses: fixture.ses },
    );
    const body = await response.text();

    expect(keypair.privateKey.length).toBeGreaterThan(1000);
    expect(response.status).toBe(400);
    expect(body).not.toContain(keypair.privateKey);
    expect(body).toContain(REDACTED_KEY);
  });

  it("is not in the audit detail of a domain mutation", async () => {
    const fixture = await seed();
    await domains(fixture).create(DOMAIN);
    await domains(fixture).setReturnPath({ domain: DOMAIN, enabled: true });

    const created = await auditRows("email_domain.created");
    expect(created.length).toBeGreaterThan(0);
    const key = await storedKey(fixture);
    expect(key?.privateKey.length).toBeGreaterThan(1000);

    for (const row of [
      ...created,
      ...(await auditRows("email_domain.return_path_enabled")),
    ]) {
      const detail = JSON.stringify(row.detail);
      // Names and a selector only — never key material of either half.
      expect(detail).not.toContain(key?.privateKey ?? "never");
      expect(detail).not.toContain(key?.publicKey ?? "never");
    }
    expect(
      created.some(
        (row) =>
          (row.detail as { selector?: string }).selector === "hogsend" &&
          (row.detail as { domain?: string }).domain === DOMAIN,
      ),
    ).toBe(true);
  });
});
