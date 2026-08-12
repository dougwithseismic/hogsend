import { createPrivateKey, createPublicKey } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  sendingDomains,
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
import { isUniqueViolation } from "../services/errors";
import {
  HOGSEND_DKIM_PROVIDER,
  readDkimKey,
  writeDkimKey,
} from "../services/ses-dkim-keys";
import {
  claimSendingDomain,
  createHogsendDomains,
  REDACTED_KEY,
} from "../services/ses-domains";
import {
  deprovisionSesTenant,
  provisionSesTenant,
} from "../services/ses-tenants";
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
/**
 * A SECOND tenant, for the boundary the ownership guard defends.
 *
 * The organization is the TENANT — a claim on a sending domain belongs to one,
 * and every environment inside it may use the domain. So a "stranger" has to be
 * a different ORG; a second environment of the same org is the customer's own
 * staging, and refusing it was the regression this suite now pins in both
 * directions.
 */
const OTHER_ORG = "ses-domains-stranger-org";
const ORGS = [ORG, OTHER_ORG];
const DOMAIN = "acme-domains.test";

let seq = 0;

interface Fixture {
  environmentId: string;
  organizationId: string;
  ses: FakeSesClient;
  tenantName: string;
}

/**
 * A fully provisioned environment: an SES tenancy, a configuration set and a
 * relay token, minted the way the pipeline mints them rather than inserted by
 * hand — so a change to provisioning that broke the domains flow shows up here.
 *
 * Pass a client to put two environments in ONE AWS account, which is the shape
 * the fleet actually has: SES identities are account-scoped and Hogsend Cloud
 * runs one shared account, so a second tenant SEES the first tenant's domain.
 *
 * Pass an `organizationId` to say WHOSE the environment is. It defaults to
 * {@link ORG}, and every test that does not care gets a fresh world anyway —
 * see the `beforeEach`, which exists because a sending domain is a GLOBAL name
 * (one live claim per domain across the whole fleet) and leftovers from the
 * previous test would otherwise decide this one's answer.
 */
async function seed(
  client?: FakeSesClient,
  organizationId: string = ORG,
): Promise<Fixture> {
  seq += 1;
  const [row] = await db
    .insert(environments)
    .values({ organizationId, name: `ses-domains-${seq}`, kind: "test" })
    .returning();
  if (!row) throw new Error("failed to seed environment");

  const ses = client ?? new FakeSesClient({ region: "us" });
  await provisionSesTenant(
    { environmentId: row.id },
    { ses, snsTopicArn: null },
  );
  return {
    environmentId: row.id,
    organizationId,
    ses,
    tenantName: sesTenantName(row.id),
  };
}

/**
 * Take the claim the way `create` takes it — BEFORE `CreateEmailIdentity`.
 *
 * Used by the tests that reproduce a provision interrupted PART WAY THROUGH:
 * the claim and the DKIM key are both written before the SES call, so a
 * faithful reproduction of "died on the way to `associateResource`" has to
 * include both. A reproduction that skipped the claim would be exercising the
 * ownership refusal instead of the self-heal.
 */
async function claim(fixture: Fixture, domain = DOMAIN) {
  return claimSendingDomain({
    db,
    organizationId: fixture.organizationId,
    environmentId: fixture.environmentId,
    domain,
    awsRegion: "us-east-1",
  });
}

/** The LIVE claim on a domain, or undefined. */
async function liveClaim(domain = DOMAIN) {
  const [row] = await db
    .select()
    .from(sendingDomains)
    .where(
      and(eq(sendingDomains.domain, domain), isNull(sendingDomains.releasedAt)),
    );
  return row;
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
    .where(inArray(cloudAuditLog.organizationId, ORGS));
  return action ? rows.filter((row) => row.action === action) : rows;
}

async function cleanup(): Promise<void> {
  await db.delete(organizations).where(inArray(organizations.id, ORGS));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
});

/**
 * A FRESH WORLD per test, and it is not tidiness.
 *
 * A sending domain is a globally unique name: one live `sending_domains` claim
 * per domain across the whole fleet, and the DKIM key behind it belongs to the
 * ORGANIZATION rather than to one environment. So a suite that reused
 * {@link DOMAIN} across tests without this would have the first test's claim
 * decide every later test's answer — the second `create` would either be
 * refused as a stranger's or silently reuse the first fixture's key, and the
 * assertions about a fresh keypair would pass vacuously.
 *
 * Deleting the organizations cascades everything: environments, tenants, relay
 * tokens, provider keys, claims and audit rows.
 */
beforeEach(async () => {
  await cleanup();
  await db.insert(organizations).values([
    { id: ORG, name: "SES Domains Test Org", region: "us" },
    { id: OTHER_ORG, name: "SES Domains Stranger Org", region: "us" },
  ]);
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

  it("heals a provision that died between createIdentity and associateResource", async () => {
    // PRD 22. The interruption is the point: SES has the identity, no tenant
    // owns it, and before the fix `create` returned a healthy-looking snapshot
    // at its existing-identity check — forty lines above the association call —
    // so the domain could never send and retrying never repaired it. Real AWS
    // answers `AccessDeniedException` 403 on that send, observed 2026-08-11.
    const fixture = await seed();
    // The interruption reproduced FAITHFULLY: `create` takes the CLAIM and
    // writes the keypair BEFORE `CreateEmailIdentity` (see the comments at
    // those calls), so a provision that died on the way to `associateResource`
    // left both behind and the identity made. The claim is what proves this
    // organization owns the domain, so a heal that skipped it would be healing
    // a domain nobody here ever added.
    await claim(fixture);
    const keypair = generateDkimKeypair();
    await writeDkimKey(
      { environmentId: fixture.environmentId, domain: DOMAIN, keypair },
      { db },
    );
    await fixture.ses.createIdentity({
      domain: DOMAIN,
      dkim: { selector: keypair.selector, privateKey: keypair.privateKey },
    });
    fixture.ses.__verifyIdentity(DOMAIN);

    const orphaned = fixture.ses.sendEmail({
      tenantName: fixture.tenantName,
      message: {
        from: `hello@${DOMAIN}`,
        to: ["person@example.test"],
        subject: "hi",
        html: "<p>hi</p>",
      },
    });
    await expect(orphaned).rejects.toThrow(/not associated/i);

    await domains(fixture).create(DOMAIN);

    // The whole assertion: after the retry the domain SENDS. Checking that
    // `associateResource` was called would pass against a call that named the
    // wrong ARN, which is the bug one layer down that PRD 21 fixed.
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

    // And the heal stays a heal: the identity SES already had is not recreated,
    // so no second keypair is minted and the customer's published record holds.
    expect(
      fixture.ses.calls.filter((c) => c.method === "createIdentity"),
    ).toHaveLength(1);
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
    // This organization DID add the domain — it holds the claim and the key —
    // but the identity in SES was rebuilt on Easy DKIM out of band. It is
    // verified for SENDING, just not by the key this stack published, and
    // every other field reads healthy.
    await claim(fixture);
    const keypair = generateDkimKeypair();
    await writeDkimKey(
      { environmentId: fixture.environmentId, domain: DOMAIN, keypair },
      { db },
    );
    await fixture.ses.createIdentity({ domain: DOMAIN });
    fixture.ses.__verifyIdentity(DOMAIN);

    const status = await domains(fixture).verify(DOMAIN);
    expect(status.state).toBe("pending");
    // SES itself says SUCCESS, so `pending` is a judgement about the ORIGIN
    // rather than a status read straight off the wire.
    expect(
      (await fixture.ses.getIdentity({ identity: DOMAIN })).dkim,
    ).toMatchObject({ status: "SUCCESS", origin: "AWS_SES" });
    // And the record we show is still ours: the one the customer has to
    // publish for the signature to be ours again.
    expect(status.records).toHaveLength(1);
    expect(status.records[0]?.purpose).toBe("dkim");
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

/**
 * THE TENANT BOUNDARY of the sending path.
 *
 * SES email identities are ACCOUNT-scoped and Hogsend Cloud runs ONE shared AWS
 * account for the whole fleet, so "who owns acme.com" is not a question SES can
 * answer: every environment sees every identity. The fact that settles it is
 * the `sending_domains` claim — `create` takes it BEFORE `CreateEmailIdentity`,
 * so the true owner always holds one by the time the identity exists.
 *
 * The claim belongs to the ORGANIZATION, and that scope is the whole point.
 * An earlier deed (a DKIM key in one environment's `provider_keys` row) drew
 * the line in the wrong place, so BOTH halves are pinned here:
 *
 *  - a DIFFERENT ORGANIZATION is refused, on every operation, with nothing
 *    written and nothing associated;
 *  - the SAME ORGANIZATION's second environment is ALLOWED, because a customer
 *    who verified a domain in production must be able to send from it in
 *    staging. Refusing that was a customer-facing 409 with no way out.
 *
 * What the guard prevents is not a wrong status code. Association is the ONLY
 * gate on the send path, so an unguarded `create` handed any relay token —
 * every provisioned environment has one — a competitor's verified domain to
 * send DKIM-signed mail from, on the account whose reputation is shared by the
 * whole fleet.
 */
describe("cross-tenant claims", () => {
  /**
   * Two environments of DIFFERENT organizations in ONE AWS account, the first
   * holding a live domain — the shape the fleet actually has.
   */
  async function strangers(): Promise<{
    account: FakeSesClient;
    owner: Fixture;
    stranger: Fixture;
  }> {
    const account = new FakeSesClient({ region: "us" });
    const owner = await seed(account, ORG);
    const stranger = await seed(account, OTHER_ORG);
    await domains(owner).create(DOMAIN);
    account.__verifyIdentity(DOMAIN);
    return { account, owner, stranger };
  }

  function message() {
    return {
      from: `hello@${DOMAIN}`,
      to: ["person@example.test"],
      subject: "hi",
      html: "<p>hi</p>",
    };
  }

  it("refuses another ORGANIZATION's create — and grants NO association", async () => {
    const { account, owner, stranger } = await strangers();

    await expect(domains(stranger).create(DOMAIN)).rejects.toMatchObject({
      code: "domain_not_owned",
    });

    // The THROW is not the harm; the ASSOCIATION is. A tenant that holds one
    // can send from the domain, so this is the assertion that matters.
    expect(
      account
        .__tenant(stranger.tenantName)
        ?.resources.some((arn) => arn.endsWith(`identity/${DOMAIN}`)),
    ).toBe(false);
    await expect(
      account.sendEmail({
        tenantName: stranger.tenantName,
        message: message(),
      }),
    ).rejects.toThrow(/not associated/i);

    // No key and no claim were minted for the stranger either, so a retry
    // cannot promote it into an owner by its own previous attempt.
    expect(await storedKey(stranger)).toBeNull();
    expect((await liveClaim())?.organizationId).toBe(ORG);

    // And the owner is untouched: their domain still sends.
    await expect(
      account.sendEmail({ tenantName: owner.tenantName, message: message() }),
    ).resolves.toMatchObject({ messageId: expect.any(String) });
  });

  it("hides the domain from another ORGANIZATION's get, records and verify", async () => {
    const { owner, stranger } = await strangers();

    // Not a redacted answer — the same answer a domain nobody added gets. A
    // status carries the identity VERBATIM in `raw`, so answering one here
    // would hand a stranger another tenant's identity state.
    expect(await domains(stranger).get(DOMAIN)).toBeNull();
    expect(await domains(stranger).records(DOMAIN)).toEqual([]);
    const status = await domains(stranger).verify(DOMAIN);
    expect(status.state).toBe("not_found");
    expect(status.records).toEqual([]);

    // The owner still sees it, so the three assertions above are about
    // ownership rather than about a fixture that never worked.
    expect((await domains(owner).get(DOMAIN))?.state).toBe("verified");
  });

  it("refuses another ORGANIZATION's return-path toggle, and never calls setMailFrom", async () => {
    const { account, owner, stranger } = await strangers();

    await expect(
      domains(stranger).setReturnPath({ domain: DOMAIN, enabled: true }),
    ).rejects.toMatchObject({ code: "not_found" });

    // A MAIL FROM write is where the victim's BOUNCES go. Nothing reached SES.
    expect(account.calls.filter((c) => c.method === "setMailFrom")).toEqual([]);
    expect(
      (await account.getIdentity({ identity: DOMAIN })).mailFrom,
    ).toBeUndefined();

    // The owner can still toggle their own.
    const on = await domains(owner).setReturnPath({
      domain: DOMAIN,
      enabled: true,
    });
    expect(on.mailFromDomain).toBe(`send.${DOMAIN}`);
  });

  it("gives the return path NO existence oracle over the shared account", async () => {
    // The bit being denied: "is acme.com already verified somewhere in the
    // Hogsend fleet?" Existence-checked-before-ownership answered 404 for a
    // domain nobody has ever created and 409 for one another tenant holds —
    // free, unlimited (bar the rate limit), and leaving no trace. `create`
    // answers the same bit on purpose, but charges a 2048-bit keypair, a
    // `CreateEmailIdentity` and an audit row for it.
    //
    // Asserted as an EQUALITY of the two answers rather than as "the taken one
    // is 404". A test that only checked the second case would still pass if the
    // first started answering something else.
    const { account, stranger } = await strangers();
    const NEVER = "never-created-domains.test";

    // Precondition: one of these domains really IS verified in this account and
    // the other really is not, or the equality below is trivially true.
    expect((await account.getIdentity({ identity: DOMAIN })).dkim.status).toBe(
      "SUCCESS",
    );
    await expect(
      account.getIdentity({ identity: NEVER }),
    ).rejects.toMatchObject({ kind: "not_found" });
    // …and the log starts clean, so what it holds below was put there by the
    // two calls under test rather than by the two probes above.
    account.calls.length = 0;

    const taken = await domains(stranger)
      .setReturnPath({ domain: DOMAIN, enabled: true })
      .catch((thrown: unknown) => thrown);
    const unknown = await domains(stranger)
      .setReturnPath({ domain: NEVER, enabled: true })
      .catch((thrown: unknown) => thrown);

    // Byte-identical refusals — same code, same sentence.
    expect((taken as { code: string }).code).toBe("not_found");
    expect((unknown as { code: string }).code).toBe("not_found");
    expect((taken as Error).message.replace(DOMAIN, "<domain>")).toBe(
      (unknown as Error).message.replace(NEVER, "<domain>"),
    );

    // …and NEITHER refusal reached SES at all — the ownership read
    // short-circuits before `getIdentity` — so response TIMING cannot answer
    // what the status code no longer does.
    expect(account.calls).toEqual([]);
  });

  it("the DATABASE refuses a second live claim, and frees the name on release", async () => {
    // The index is the last line of defence, and the only one that holds under
    // CONCURRENCY: two organizations calling `create` for a never-before-seen
    // domain both read no identity and no claim, so nothing in application
    // code can tell them apart. Exactly one wins this index; the loser re-reads
    // and is refused.
    //
    // Asserted at the ROW level rather than through two racing calls, because a
    // race that happened to serialize would pass against no index at all.
    const owner = await seed(undefined, ORG);
    const stranger = await seed(undefined, OTHER_ORG);
    await claim(owner);

    const second = db.insert(sendingDomains).values({
      organizationId: OTHER_ORG,
      environmentId: stranger.environmentId,
      domain: DOMAIN,
      awsRegion: "us-east-1",
    });
    await expect(second).rejects.toSatisfy(isUniqueViolation);

    // …and it is PARTIAL, so a released domain really does return to the pool.
    // A plain unique index would pass the assertion above and lock the name
    // away forever, which is the failure this whole table exists to remove.
    await db
      .update(sendingDomains)
      .set({ releasedAt: new Date() })
      .where(eq(sendingDomains.domain, DOMAIN));
    await expect(
      db.insert(sendingDomains).values({
        organizationId: OTHER_ORG,
        environmentId: stranger.environmentId,
        domain: DOMAIN,
        awsRegion: "us-east-1",
      }),
    ).resolves.toBeDefined();
  });

  it("refuses another ORGANIZATION for a claimed domain SES does not hold yet", async () => {
    // THE RACE the old environment-scoped deed could not close, and the reason
    // the claim is taken BEFORE `CreateEmailIdentity` rather than inferred
    // from it: here SES holds NOTHING, so there is no identity to ask about.
    // The claim is the only fact in the world that says whose domain this is.
    //
    // Reached in production two ways — a create that died between the claim
    // and the SES call, and an identity deleted out of band — and by two
    // concurrent creates for a never-before-seen domain, where exactly one
    // wins the partial unique index and the loser must be refused here.
    const account = new FakeSesClient({ region: "us" });
    const owner = await seed(account, ORG);
    const stranger = await seed(account, OTHER_ORG);
    await claim(owner);
    // Precondition: SES really is empty, so nothing below can be answered by
    // the identity register.
    await expect(
      account.getIdentity({ identity: DOMAIN }),
    ).rejects.toMatchObject({ kind: "not_found" });

    await expect(domains(stranger).create(DOMAIN)).rejects.toMatchObject({
      code: "domain_not_owned",
    });

    // Nothing was created, nothing associated, and the claim did not move.
    expect(account.calls.filter((c) => c.method === "createIdentity")).toEqual(
      [],
    );
    expect((await liveClaim())?.organizationId).toBe(ORG);

    // …and the owner can still finish what it started, so the refusal is
    // about ownership rather than about a claim that blocks everybody.
    await expect(domains(owner).create(DOMAIN)).resolves.toMatchObject({
      domain: DOMAIN,
    });
  });

  it("fails CLOSED on an identity nobody holds a claim for, and says the remedy is manual", async () => {
    // An identity created out of band — a console click, a script, one left
    // behind by an account that is gone. NO organization can heal this one,
    // and that is the correct posture: the alternative is a first-come-take-it
    // hatch. So the message has to send an operator to SES rather than leave
    // them retrying a call that will never start working.
    const account = new FakeSesClient({ region: "us" });
    const fixture = await seed(account);
    await account.createIdentity({ domain: DOMAIN });

    const error = await domains(fixture)
      .create(DOMAIN)
      .catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ code: "domain_not_owned" });
    expect((error as Error).message).toMatch(/manual/i);
    expect(
      account
        .__tenant(fixture.tenantName)
        ?.resources.some((arn) => arn.endsWith(`identity/${DOMAIN}`)),
    ).toBe(false);
    // And the refusal took NO claim. Taking one here — "I asked first" — is
    // exactly the hatch this fails closed to avoid, and it would also let the
    // very next retry succeed, turning a permanent refusal into a land grab.
    expect(await liveClaim()).toBeUndefined();
  });

  /**
   * THE REGRESSION, in the other direction.
   *
   * An environment-scoped deed answered "no" here, so a customer who verified
   * `acme.com` in production got a 409 `domain_not_owned` from their own
   * staging environment — for their own domain, with a message telling them an
   * operator had to delete the identity by hand. There was no way out by
   * construction.
   */
  describe("the same organization's second environment", () => {
    it("may use a domain its sibling verified, and can actually send", async () => {
      const account = new FakeSesClient({ region: "us" });
      const production = await seed(account, ORG);
      const staging = await seed(account, ORG);

      const created = await domains(production).create(DOMAIN);
      account.__verifyIdentity(DOMAIN);

      // The whole point: the SAME call, from the sibling environment.
      const fromStaging = await domains(staging).create(DOMAIN);
      expect(fromStaging.state).toBe("verified");

      // …and it renders the customer's DNS record rather than an empty setup
      // screen. The key lives in production's `provider_keys` row, so an
      // environment-scoped read would have found nothing and published none.
      expect(fromStaging.records).toHaveLength(1);
      expect(fromStaging.records[0]?.name).toBe(dkimRecordHost(DOMAIN));
      expect(fromStaging.records[0]?.value).toBe(created.records[0]?.value);

      // The assertion that matters: staging's tenant is ASSOCIATED, so mail
      // from the domain actually leaves. A status alone proves nothing.
      await expect(
        account.sendEmail({
          tenantName: staging.tenantName,
          message: {
            from: `hello@${DOMAIN}`,
            to: ["person@example.test"],
            subject: "hi",
            html: "<p>hi</p>",
          },
        }),
      ).resolves.toMatchObject({ messageId: expect.any(String) });

      // ONE claim, still recording the environment that first registered it,
      // and NO second keypair — the customer's published TXT record holds.
      expect((await liveClaim())?.environmentId).toBe(production.environmentId);
      expect(await storedKey(staging)).toBeNull();
      expect(
        account.calls.filter((c) => c.method === "createIdentity"),
      ).toHaveLength(1);
    });

    it("reads, verifies and toggles the return path on it", async () => {
      const account = new FakeSesClient({ region: "us" });
      const production = await seed(account, ORG);
      const staging = await seed(account, ORG);
      await domains(production).create(DOMAIN);
      account.__verifyIdentity(DOMAIN);

      expect((await domains(staging).get(DOMAIN))?.state).toBe("verified");
      expect(await domains(staging).records(DOMAIN)).toHaveLength(1);
      expect((await domains(staging).verify(DOMAIN)).state).toBe("verified");

      const on = await domains(staging).setReturnPath({
        domain: DOMAIN,
        enabled: true,
      });
      expect(on.mailFromDomain).toBe(`send.${DOMAIN}`);
    });

    it("reuses the sibling's key when SES lost the identity", async () => {
      // The nastiest shape of the same bug: a per-environment key read would
      // find nothing here and mint a FRESH keypair, silently invalidating the
      // TXT record the customer already published in their own DNS.
      const account = new FakeSesClient({ region: "us" });
      const production = await seed(account, ORG);
      const staging = await seed(account, ORG);
      await domains(production).create(DOMAIN);
      const original = await storedKey(production);
      expect(original?.privateKey.length).toBeGreaterThan(1000);

      await account.deleteIdentity({ identity: DOMAIN });
      const again = await domains(staging).create(DOMAIN);

      expect(again.records[0]?.value).toBe(`p=${original?.publicKey}`);
      expect(
        account.calls
          .filter((c) => c.method === "createIdentity")
          .map((c) => (c.args[0] as { dkim?: { privateKey: string } }).dkim),
      ).toEqual([
        { selector: "hogsend", privateKey: original?.privateKey },
        { selector: "hogsend", privateKey: original?.privateKey },
      ]);
    });
  });

  /**
   * REGRESSION 2: an environment-scoped deed was DESTROYED by deleting the
   * environment (`provider_keys` cascades) while the SES identity survived in
   * the shared account — so the domain became permanently unclaimable, by
   * anybody, including the customer whose domain it is.
   */
  describe("after the registering environment is deleted", () => {
    it("leaves the claim alive for the organization while a sibling remains", async () => {
      const account = new FakeSesClient({ region: "us" });
      const production = await seed(account, ORG);
      const staging = await seed(account, ORG);
      await domains(production).create(DOMAIN);
      account.__verifyIdentity(DOMAIN);

      // Production is torn down and removed. A sibling still holds a tenancy,
      // so nothing may be released: staging is still sending from this domain.
      await deprovisionSesTenant(
        { environmentId: production.environmentId },
        { ses: account },
      );
      await db
        .delete(environments)
        .where(eq(environments.id, production.environmentId));

      // The identity survived, deliberately — releasing it here would delete a
      // live production sending domain out from under staging.
      expect(await account.getIdentity({ identity: DOMAIN })).toMatchObject({
        identity: DOMAIN,
      });

      const held = await liveClaim();
      expect(held?.organizationId).toBe(ORG);
      // The FK is SET NULL, not CASCADE. That is the fix: the row survives its
      // environment, and only the support column goes blank.
      expect(held?.environmentId).toBeNull();

      // And the org can still use its own domain.
      expect((await domains(staging).get(DOMAIN))?.state).toBe("verified");
      await expect(domains(staging).create(DOMAIN)).resolves.toMatchObject({
        state: "verified",
      });
    });

    it("releases the claim AND deletes the identity when the last tenancy goes", async () => {
      const account = new FakeSesClient({ region: "us" });
      const only = await seed(account, ORG);
      await domains(only).create(DOMAIN);
      // Precondition, or the assertions below prove nothing.
      expect(await account.getIdentity({ identity: DOMAIN })).toBeDefined();
      expect(await liveClaim()).toBeDefined();

      await deprovisionSesTenant(
        { environmentId: only.environmentId },
        { ses: account },
      );

      // The identity is GONE from the shared account — the leak that made the
      // refusal permanent. `deleteIdentity` was never called before this.
      await expect(account.getIdentity({ identity: DOMAIN })).rejects.toThrow(
        SesError,
      );
      // …and the claim is released, so the name is back in the pool.
      expect(await liveClaim()).toBeUndefined();

      // Which means ANOTHER organization can now take it cleanly.
      const next = await seed(new FakeSesClient({ region: "us" }), OTHER_ORG);
      await expect(domains(next).create(DOMAIN)).resolves.toMatchObject({
        domain: DOMAIN,
        state: "pending",
      });
    });

    it("lets the SAME organization re-add the domain from a brand new environment", async () => {
      // The end-to-end shape of regression 2: a customer deletes their only
      // environment, makes a new one, and types the same domain. Before, this
      // was a permanent 409 telling them to call an operator.
      const account = new FakeSesClient({ region: "us" });
      const first = await seed(account, ORG);
      await domains(first).create(DOMAIN);

      await deprovisionSesTenant(
        { environmentId: first.environmentId },
        { ses: account },
      );
      await db
        .delete(environments)
        .where(eq(environments.id, first.environmentId));

      const replacement = await seed(account, ORG);
      const status = await domains(replacement).create(DOMAIN);

      expect(status.domain).toBe(DOMAIN);
      expect(status.records).toHaveLength(1);
      expect((await liveClaim())?.organizationId).toBe(ORG);
      // It really can send: association, not status, is the gate.
      account.__verifyIdentity(DOMAIN);
      await expect(
        account.sendEmail({
          tenantName: replacement.tenantName,
          message: {
            from: `hello@${DOMAIN}`,
            to: ["person@example.test"],
            subject: "hi",
            html: "<p>hi</p>",
          },
        }),
      ).resolves.toMatchObject({ messageId: expect.any(String) });
    });
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

  /**
   * PRD 15: changing the label on a LIVE return path is a migration, not an
   * edit. The customer published `send.<domain>` and it resolved; pointing SES
   * at `notifications.<domain>` invalidates that instantly, and the new name
   * has no MX yet.
   *
   * So the answer must go back to `pending` rather than inheriting the old
   * name's verified status. Reporting the relabelled domain as still-configured
   * would tell the customer there is nothing to do at the exact moment there is
   * something to do, and `BehaviorOnMxFailure: USE_DEFAULT_VALUE` would quietly
   * carry their bounces on SES's default return path while they believed the
   * branded one was live.
   */
  it("relabelling a LIVE return path reports pending, not the old verified state", async () => {
    const fixture = await seed();
    await domains(fixture).create(DOMAIN);
    await domains(fixture).setReturnPath({ domain: DOMAIN, enabled: true });
    fixture.ses.__verifyMailFrom(DOMAIN);

    // Precondition: `send.` really is live, or the assertion below proves
    // nothing (a never-verified path is trivially pending).
    const live = await domains(fixture).verify(DOMAIN);
    expect(
      live.records.filter(
        (r) => r.name === `send.${DOMAIN}` && r.status === "verified",
      ),
    ).toHaveLength(2);

    const relabelled = await domains(fixture).setReturnPath({
      domain: DOMAIN,
      enabled: true,
      label: "notifications",
    });

    expect(relabelled.mailFromDomain).toBe(`notifications.${DOMAIN}`);
    // Still exactly two: a relabel MOVES the pair, it does not accumulate one.
    const returnPath = relabelled.status.records.filter(
      (r) => r.purpose === "mx" || r.purpose === "spf",
    );
    expect(returnPath).toHaveLength(2);
    expect(returnPath.map((r) => r.name)).toEqual([
      `notifications.${DOMAIN}`,
      `notifications.${DOMAIN}`,
    ]);
    expect(returnPath.every((r) => r.status === "pending")).toBe(true);
    // The old name must be gone entirely, not left behind as a stale row the
    // customer would keep publishing.
    expect(
      relabelled.status.records.some((r) => r.name === `send.${DOMAIN}`),
    ).toBe(false);
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
  organizationId: string = ORG,
): Promise<Fixture & { token: string }> {
  seq += 1;
  const [row] = await db
    .insert(environments)
    .values({
      organizationId,
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
    organizationId,
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

  it("answer 409 when the domain belongs to another organization", async () => {
    // Every provisioned environment holds a relay token, so this request is
    // authenticated and well-formed. 409 rather than 404 or 400, because the
    // caller's request is fine and the CONFLICT is with the world.
    const account = new FakeSesClient({ region: "us" });
    const owner = await seedWithToken(account, ORG);
    const stranger = await seedWithToken(account, OTHER_ORG);
    await handleDomainCreate(
      request("", { token: owner.token, body: { domain: DOMAIN } }),
      { db, ses: account },
    );

    const response = await handleDomainCreate(
      request("", { token: stranger.token, body: { domain: DOMAIN } }),
      { db, ses: account },
    );

    expect(response.status).toBe(409);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ error: "domain_not_owned" });
    // An operator can act on it…
    expect(body).toMatch(/manual/i);
    // …and it names NOBODY. A refusal that leaked which tenant holds the
    // domain would answer the question the attacker asked.
    expect(body).not.toContain(owner.environmentId);
    expect(body).not.toContain(owner.tenantName);
    expect(body).not.toContain(ORG);
  });

  it("answer 200 when the domain belongs to the caller's OWN organization", async () => {
    // Same call, same shared AWS account, one difference: the caller is the
    // customer's second environment rather than a stranger. The 409 above must
    // not be reachable this way — it was, and it had no remedy.
    const account = new FakeSesClient({ region: "us" });
    const production = await seedWithToken(account, ORG);
    const staging = await seedWithToken(account, ORG);
    await handleDomainCreate(
      request("", { token: production.token, body: { domain: DOMAIN } }),
      { db, ses: account },
    );

    const response = await handleDomainCreate(
      request("", { token: staging.token, body: { domain: DOMAIN } }),
      { db, ses: account },
    );

    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { status: { records: unknown[] } }).status
        .records,
    ).toHaveLength(1);
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
