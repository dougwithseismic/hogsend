import { readFileSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as inboundRoute } from "@/app/api/email/domains/inbound/route";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import { cloudAuditLog, environments, organizations } from "../db/schema";
import { env } from "../env";
import { handleDomainInbound } from "../lib/email-domains";
import {
  foreignMxExchanges,
  INBOUND_MX_PRIORITY,
  INBOUND_OBJECT_KEY_PREFIX,
  INBOUND_RULE_SET_NAME,
  INBOUND_SUBDOMAIN,
  InvalidInboundLabelError,
  inboundDomainFor,
  inboundMxOverridePhrase,
  inboundRuleName,
  planInboundRemoval,
  planInboundRule,
  resolveInboundStore,
} from "../lib/inbound-domains";
import {
  claimSendingDomain,
  DomainNotOwnedError,
} from "../services/ses-domains";
import type { InboundConfig } from "../services/ses-inbound-config";
import {
  findInboundRecipientOwner,
  readInboundConfig,
  writeInboundConfig,
} from "../services/ses-inbound-config";
import {
  createHogsendInbound,
  ForeignInboundMxError,
  ForeignInboundRuleError,
  ForeignInboundRuleSetError,
  InboundLabelConflictError,
  InboundMxLookupError,
  InboundNotConfiguredError,
  MissingForwardAddressError,
} from "../services/ses-inbound-domains";
import { provisionSesTenant } from "../services/ses-tenants";
import { FakeSesClient } from "../ses/fake";
import { FakeSesInboundClient } from "../ses/inbound/fake";
import type {
  SesInboundRule,
  SesInboundStoreAction,
} from "../ses/inbound/types";
import { SES_INBOUND_MAX_RECIPIENTS_PER_RULE } from "../ses/inbound/types";
import { SesError } from "../ses/types";

/**
 * Inbound provisioning (PRD 16 task 3), against the deterministic inbound Fake.
 * Nothing here reaches AWS and nothing here resolves real DNS.
 *
 * Four properties carry this suite, and every one of them fails SILENTLY in
 * production if it regresses:
 *
 *  - **the apex is never the record we emit.** Repointing a customer's apex MX
 *    at SES does not add replies, it DELETES their company mailbox — Google
 *    Workspace, Microsoft 365, whatever they run on. There is no error, no
 *    bounce to us, and no way back except their own DNS history;
 *  - **a rule set we do not own is never displaced.** Only one receipt rule set
 *    is active per account per region, so activating ours silently stops
 *    receiving for every other tenant in that region at once;
 *  - **a rule is never left with an empty recipient list.** SES reads "no
 *    recipients" as "every recipient on every verified domain", so an emptied
 *    rule is one tenant's action swallowing everybody's inbound mail;
 *  - **inbound never turns on without somewhere to forward to.** A reply
 *    intercepted and not delivered to a human is a broken business, not a
 *    feature.
 */

const ORG = "ses-inbound-test-org";
/**
 * A SECOND tenant. A sending-domain claim belongs to an ORGANIZATION, so the
 * only true stranger is another org — a second environment of the same org is
 * the customer's own staging and is deliberately allowed.
 */
const STRANGER_ORG = "ses-inbound-stranger-org";
const ORGS = [ORG, STRANGER_ORG];
const DOMAIN = "acme-inbound.test";
const OTHER_DOMAIN = "beta-inbound.test";
/** Deliberately never claimed by a fixture — see `describe("cross-tenant claims")`. */
const UNCLAIMED_DOMAIN = "stranger-inbound.test";
/** Claimed by {@link STRANGER_ORG} only. Nobody in {@link ORG} may touch it. */
const STRANGER_DOMAIN = "victim-inbound.test";
const BUCKET = "hogsend-ses-inbound";
const TOPIC = "arn:aws:sns:us-east-1:000000000000:hogsend-ses-inbound";
const FORWARD = "support@acme-inbound.test";
const US_INBOUND_HOST = "inbound-smtp.us-east-1.amazonaws.com";

const STORE: SesInboundStoreAction = {
  bucketName: BUCKET,
  topicArn: TOPIC,
  objectKeyPrefix: INBOUND_OBJECT_KEY_PREFIX,
};

let seq = 0;

interface Fixture {
  environmentId: string;
  organizationId: string;
  inbound: FakeSesInboundClient;
  /** The relay token this environment's instance holds — the ONLY credential
   * the control-plane endpoints accept. */
  token: string;
  /** Every name this fixture's resolver answers MX records for. */
  mx: Map<string, { exchange: string; priority: number }[]>;
  /** Set to make the resolver THROW, which must fail closed. */
  mxError?: Error;
}

/**
 * A provisioned environment plus a fresh inbound Fake. The SES tenancy is
 * minted the way the pipeline mints it rather than inserted by hand, so a
 * change to provisioning that broke this flow shows up here.
 */
async function seed(
  opts: { organizationId?: string; claims?: string[] } = {},
): Promise<Fixture> {
  seq += 1;
  const organizationId = opts.organizationId ?? ORG;
  const [row] = await db
    .insert(environments)
    .values({ organizationId, name: `ses-inbound-${seq}`, kind: "test" })
    .returning();
  if (!row) throw new Error("failed to seed environment");

  const provisioned = await provisionSesTenant(
    { environmentId: row.id },
    { ses: new FakeSesClient({ region: "us" }), snsTopicArn: null },
  );
  // The SENDING claim on each domain this fixture receives for. Replies are
  // only ever turned on for a domain the ORGANIZATION already added, and the
  // `sending_domains` row is the only record of who claimed it in a shared AWS
  // account. `enable` and `disable` both refuse a domain with no claim, so a
  // fixture that skipped this would be exercising that refusal in every test.
  //
  // Idempotent within an org, which is what lets every fixture here claim the
  // same two names: the claim belongs to the tenant, not to the environment.
  for (const domain of opts.claims ?? [DOMAIN, OTHER_DOMAIN]) {
    await claimSendingDomain({
      db,
      organizationId,
      environmentId: row.id,
      domain,
      awsRegion: "us-east-1",
    });
  }
  return {
    environmentId: row.id,
    organizationId,
    inbound: new FakeSesInboundClient({ region: "us" }),
    token: provisioned.relayToken,
    mx: new Map(),
  };
}

/**
 * The seams every caller of this service is given in this suite: the inbound
 * Fake, a configured store, and a resolver that answers from the fixture.
 *
 * NEVER the real resolver: a suite that reached DNS would be asserting the
 * state of somebody's zone file rather than of this code.
 */
function deps(fixture: Fixture) {
  return {
    db,
    inbound: fixture.inbound,
    store: { bucketName: BUCKET, topicArn: TOPIC },
    lookupMx: async (name: string) => {
      if (fixture.mxError) throw fixture.mxError;
      return fixture.mx.get(name) ?? [];
    },
  };
}

function service(fixture: Fixture) {
  return createHogsendInbound(
    { environmentId: fixture.environmentId },
    deps(fixture),
  );
}

async function ruleNames(fixture: Fixture): Promise<string[]> {
  const set = await fixture.inbound.getRuleSet({
    ruleSetName: INBOUND_RULE_SET_NAME,
  });
  return set.rules.map((rule) => rule.ruleName);
}

async function recipientsOf(
  fixture: Fixture,
  ruleName = inboundRuleName(1),
): Promise<string[]> {
  const rule = await fixture.inbound.getRule({
    ruleSetName: INBOUND_RULE_SET_NAME,
    ruleName,
  });
  return rule.recipients;
}

async function auditRows(action?: string) {
  const rows = await db
    .select()
    .from(cloudAuditLog)
    .where(eq(cloudAuditLog.organizationId, ORG));
  return action ? rows.filter((row) => row.action === action) : rows;
}

async function cleanup(): Promise<void> {
  await db.delete(organizations).where(inArray(organizations.id, ORGS));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();
  await db.insert(organizations).values([
    { id: ORG, name: "SES Inbound Test Org", region: "us" },
    { id: STRANGER_ORG, name: "SES Inbound Stranger Org", region: "us" },
  ]);
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
});

// ---------------------------------------------------------------------------
// The pure vocabulary
// ---------------------------------------------------------------------------

describe("inboundDomainFor", () => {
  it("always prepends a label, so the apex can never be the target", () => {
    // THE rule of this PRD. The record we emit is `reply.<domain>`; the apex
    // is where the customer's real mailbox lives and we never name it.
    expect(inboundDomainFor(DOMAIN)).toBe(`${INBOUND_SUBDOMAIN}.${DOMAIN}`);
    expect(inboundDomainFor(DOMAIN)).not.toBe(DOMAIN);
    expect(inboundDomainFor(DOMAIN, "inbox")).toBe(`inbox.${DOMAIN}`);
  });

  it("refuses a label that would collapse onto the apex or leave DNS", () => {
    // An empty label yields the apex; a dotted one is either a typo or an
    // attempt to point somebody else's domain at our rule.
    for (const bad of ["", " ", ".", "reply.", "a.b", "-x", "x-", "@"]) {
      expect(
        () => inboundDomainFor(DOMAIN, bad),
        `expected ${JSON.stringify(bad)} to be refused`,
      ).toThrow(InvalidInboundLabelError);
    }
  });
});

describe("foreignMxExchanges", () => {
  it("treats our own inbound host as ours, whatever the case or trailing dot", () => {
    // A re-drive reads back the record the customer already published. Seeing
    // our own host and calling it foreign would make every second enable
    // demand a typed override.
    expect(
      foreignMxExchanges(
        [
          { exchange: "INBOUND-SMTP.us-east-1.amazonaws.com.", priority: 10 },
          { exchange: US_INBOUND_HOST, priority: 10 },
        ],
        US_INBOUND_HOST,
      ),
    ).toEqual([]);
  });

  it("names every exchange that is not ours", () => {
    expect(
      foreignMxExchanges(
        [
          { exchange: "aspmx.l.google.com", priority: 1 },
          { exchange: US_INBOUND_HOST, priority: 10 },
        ],
        US_INBOUND_HOST,
      ),
    ).toEqual(["aspmx.l.google.com"]);
  });
});

describe("the object key prefix", () => {
  it("matches the prefix the IAM policy grants the relay", () => {
    // `scripts/aws-bootstrap-events.sh` grants `s3:GetObject` on
    // `<bucket>/<INBOUND_PREFIX>*` and nothing else. If this constant and that
    // default drift, SES stores every reply perfectly and the read comes back
    // AccessDenied — a break that shows up only when real mail arrives, weeks
    // after both halves were reviewed and looked right.
    const script = readFileSync(
      new URL("../../scripts/aws-bootstrap-events.sh", import.meta.url),
      "utf8",
    );
    const granted = script.match(
      /INBOUND_PREFIX="\$\{INBOUND_PREFIX:-(.+?)\}"/,
    );
    expect(granted?.[1]).toBe(INBOUND_OBJECT_KEY_PREFIX);
  });
});

describe("resolveInboundStore", () => {
  it("is a MODE, not a misconfiguration: absent yields null", () => {
    expect(resolveInboundStore({}, "us")).toBeNull();
    // Half configured is NOT half working — a rule needs both the bucket and
    // the topic, and SES accepts a bucket alone while notifying nobody.
    expect(
      resolveInboundStore({ CLOUD_SES_INBOUND_BUCKET: BUCKET }, "us"),
    ).toBeNull();
  });

  it("pins the topic PER REGION, because SES receiving resources are", () => {
    const vars = {
      CLOUD_SES_INBOUND_BUCKET: BUCKET,
      CLOUD_SES_INBOUND_TOPIC_ARN_US: TOPIC,
    };
    expect(resolveInboundStore(vars, "us")).toEqual({
      bucketName: BUCKET,
      topicArn: TOPIC,
    });
    // The bucket is shared (AWS's one exception); the topic is not.
    expect(resolveInboundStore(vars, "eu")).toBeNull();
  });
});

describe("planInboundRule", () => {
  function rule(overrides: Partial<SesInboundRule> = {}): SesInboundRule {
    return {
      ruleName: inboundRuleName(1),
      recipients: ["reply.one.test"],
      enabled: true,
      scanEnabled: true,
      tlsPolicy: "Optional",
      actions: [{ kind: "store", ...STORE }],
      ...overrides,
    };
  }

  it("PACKS a second domain into the rule that already has room", () => {
    // The decided architecture: a rule matches DOMAINS, 500 of them, and every
    // tenant shares one action — so a rule per tenant would burn the 200-rule
    // ceiling at 200 customers for no gain.
    expect(
      planInboundRule({
        rules: [rule()],
        recipient: "reply.two.test",
        store: STORE,
      }),
    ).toEqual({
      kind: "write",
      ruleName: inboundRuleName(1),
      recipients: ["reply.one.test", "reply.two.test"],
    });
  });

  it("rolls to a NEW shard when the rule is at AWS's 500 ceiling", () => {
    const full = rule({
      recipients: Array.from(
        { length: SES_INBOUND_MAX_RECIPIENTS_PER_RULE },
        (_, index) => `reply.d${index}.test`,
      ),
    });

    expect(
      planInboundRule({
        rules: [full],
        recipient: "reply.new.test",
        store: STORE,
      }),
    ).toEqual({
      kind: "write",
      ruleName: inboundRuleName(2),
      recipients: ["reply.new.test"],
    });
  });

  it("is CONVERGED when the domain is already held by a healthy rule", () => {
    expect(
      planInboundRule({
        rules: [rule()],
        recipient: "reply.one.test",
        store: STORE,
      }),
    ).toEqual({ kind: "converged", ruleName: inboundRuleName(1) });
  });

  it("REPAIRS a held rule that is disabled or points somewhere else", () => {
    // A rule created disabled exists, reads back cleanly and drops every reply
    // on the floor. "Already listed" is therefore not the same as "working".
    for (const broken of [
      rule({ enabled: false }),
      rule({ scanEnabled: false }),
      rule({ actions: [] }),
      rule({ actions: [{ kind: "store", bucketName: "someone-elses" }] }),
    ]) {
      expect(
        planInboundRule({
          rules: [broken],
          recipient: "reply.one.test",
          store: STORE,
        }),
      ).toEqual({
        kind: "write",
        ruleName: inboundRuleName(1),
        recipients: ["reply.one.test"],
      });
    }
  });

  it("refuses to reach into a rule it did not name", () => {
    // A console-made rule may carry a bounce action, another tenant's bucket,
    // or a recipient list we cannot reason about. `putRule` REPLACES, so
    // packing into one would silently delete whatever it holds.
    expect(
      planInboundRule({
        rules: [rule({ ruleName: "made-in-the-console" })],
        recipient: "reply.one.test",
        store: STORE,
      }),
    ).toEqual({ kind: "foreign", ruleName: "made-in-the-console" });
  });
});

describe("planInboundRemoval", () => {
  function rule(recipients: string[], ruleName = inboundRuleName(1)) {
    return {
      ruleName,
      recipients,
      enabled: true,
      scanEnabled: true,
      tlsPolicy: "Optional" as const,
      actions: [{ kind: "store" as const, ...STORE }],
    };
  }

  it("shrinks the rule, leaving every other domain receiving", () => {
    expect(
      planInboundRemoval({
        rules: [rule(["reply.one.test", "reply.two.test"])],
        recipients: ["reply.one.test"],
      }),
    ).toEqual({
      kind: "steps",
      steps: [{ ruleName: inboundRuleName(1), recipients: ["reply.two.test"] }],
    });
  });

  it("removes EVERY name a domain receives on, across shards", () => {
    // A domain re-enabled on a different label, or a rule list left crooked by
    // a partial failure, holds more than one name. Removing one and reporting
    // success would leave mail still arriving.
    expect(
      planInboundRemoval({
        rules: [
          rule(["reply.one.test", "keep.two.test"]),
          rule(["inbox.one.test"], inboundRuleName(2)),
        ],
        recipients: ["reply.one.test", "inbox.one.test"],
      }),
    ).toEqual({
      kind: "steps",
      steps: [
        { ruleName: inboundRuleName(1), recipients: ["keep.two.test"] },
        { ruleName: inboundRuleName(2), recipients: [] },
      ],
    });
  });

  it("DELETES the rule rather than emptying it", () => {
    // `ReceiptRule.Recipients`, verbatim: "If this field is not specified, this
    // rule matches all recipients on all verified domains." An emptied rule is
    // therefore not an inert rule, it is a rule that swallows every OTHER
    // tenant's inbound mail into this tenant's bucket.
    expect(
      planInboundRemoval({
        rules: [rule(["reply.one.test"])],
        recipients: ["reply.one.test"],
      }),
    ).toEqual({
      kind: "steps",
      steps: [{ ruleName: inboundRuleName(1), recipients: [] }],
    });
  });

  it("converges on a domain that is not there", () => {
    expect(
      planInboundRemoval({
        rules: [rule(["reply.one.test"])],
        recipients: ["reply.gone.test"],
      }),
    ).toEqual({ kind: "steps", steps: [] });
  });

  it("refuses to edit a rule it did not name", () => {
    expect(
      planInboundRemoval({
        rules: [rule(["reply.one.test"], "made-in-the-console")],
        recipients: ["reply.one.test"],
      }),
    ).toEqual({ kind: "foreign", ruleName: "made-in-the-console" });
  });
});

// ---------------------------------------------------------------------------
// enable
// ---------------------------------------------------------------------------

describe("enable", () => {
  it("emits EXACTLY ONE MX record, at reply.<domain> and never the apex", async () => {
    const fixture = await seed();

    const status = await service(fixture).enable({
      domain: DOMAIN,
      forwardTo: FORWARD,
    });

    expect(status.records).toHaveLength(1);
    const [record] = status.records;
    expect(record).toMatchObject({
      type: "MX",
      name: `${INBOUND_SUBDOMAIN}.${DOMAIN}`,
      value: US_INBOUND_HOST,
      priority: INBOUND_MX_PRIORITY,
      purpose: "mx",
    });
    // The assertion the whole PRD is shaped around. A record naming the apex
    // would delete the customer's company email, and every other assertion in
    // this file would still pass.
    expect(status.records.map((r) => r.name)).not.toContain(DOMAIN);
    expect(status.state).toBe("pending");
  });

  it("writes ONE enabled, scanned rule carrying the S3 + SNS action", async () => {
    const fixture = await seed();

    await service(fixture).enable({ domain: DOMAIN, forwardTo: FORWARD });

    expect(await ruleNames(fixture)).toEqual([inboundRuleName(1)]);
    const rule = await fixture.inbound.getRule({
      ruleSetName: INBOUND_RULE_SET_NAME,
      ruleName: inboundRuleName(1),
    });
    expect(rule).toMatchObject({
      recipients: [`${INBOUND_SUBDOMAIN}.${DOMAIN}`],
      enabled: true,
      scanEnabled: true,
      actions: [{ kind: "store", bucketName: BUCKET, topicArn: TOPIC }],
    });
    // And it is ACTIVE: a rule set nobody activated receives nothing at all.
    expect(await fixture.inbound.getActiveRuleSet()).toMatchObject({
      ruleSetName: INBOUND_RULE_SET_NAME,
    });
  });

  it("REFUSES with no forwarding address, and writes nothing to SES", async () => {
    // EARS: "WHEN inbound is enabled without a forwarding address configured,
    // the system SHALL refuse to enable it, because that configuration
    // silently swallows a customer's replies."
    const fixture = await seed();

    await expect(service(fixture).enable({ domain: DOMAIN })).rejects.toThrow(
      MissingForwardAddressError,
    );
    await expect(
      service(fixture).enable({ domain: DOMAIN, forwardTo: "not-an-address" }),
    ).rejects.toThrow(MissingForwardAddressError);

    // Refused means NOTHING happened: no rule set, no rule, nothing active.
    expect(fixture.inbound.__ruleSetNames()).toEqual([]);
    expect(await fixture.inbound.getActiveRuleSet()).toEqual({ rules: [] });
  });

  it("remembers the forwarding address, so a re-drive need not restate it", async () => {
    const fixture = await seed();
    await service(fixture).enable({ domain: DOMAIN, forwardTo: FORWARD });

    const stored: InboundConfig | null = await readInboundConfig(
      { environmentId: fixture.environmentId, domain: DOMAIN },
      { db },
    );
    expect(stored).toEqual({ forwardTo: FORWARD, label: INBOUND_SUBDOMAIN });

    // The second call names no address and is still legal — the mandatory
    // forwarding destination is CONFIGURED, which is what the rule asks.
    await expect(
      service(fixture).enable({ domain: DOMAIN }),
    ).resolves.toMatchObject({ state: "pending" });
  });

  it("REFUSES a domain whose inbound name already has an MX we did not create", async () => {
    // The guard that makes the unrecoverable mistake impossible rather than
    // merely discouraged. Somebody else's mail already arrives here.
    const fixture = await seed();
    fixture.mx.set(`${INBOUND_SUBDOMAIN}.${DOMAIN}`, [
      { exchange: "aspmx.l.google.com", priority: 1 },
    ]);

    const error = await service(fixture)
      .enable({ domain: DOMAIN, forwardTo: FORWARD })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ForeignInboundMxError);
    // The message has to carry BOTH the host that would be displaced and the
    // exact phrase that overrides it, or the operator cannot act on it.
    expect((error as Error).message).toContain("aspmx.l.google.com");
    expect((error as Error).message).toContain(
      inboundMxOverridePhrase(`${INBOUND_SUBDOMAIN}.${DOMAIN}`),
    );
    expect(fixture.inbound.__ruleSetNames()).toEqual([]);
  });

  it("proceeds on the TYPED confirmation, and only the exact one", async () => {
    const fixture = await seed();
    const inboundDomain = `${INBOUND_SUBDOMAIN}.${DOMAIN}`;
    fixture.mx.set(inboundDomain, [
      { exchange: "aspmx.l.google.com", priority: 1 },
    ]);
    const inbound = service(fixture);

    // A near miss is a miss. The phrase names the domain precisely so it
    // cannot be pasted from one domain's confirmation into another's.
    for (const wrong of [
      "yes",
      "REPLACE",
      inboundMxOverridePhrase(OTHER_DOMAIN),
    ]) {
      await expect(
        inbound.enable({
          domain: DOMAIN,
          forwardTo: FORWARD,
          confirmMxReplacement: wrong,
        }),
      ).rejects.toThrow(ForeignInboundMxError);
    }

    await expect(
      inbound.enable({
        domain: DOMAIN,
        forwardTo: FORWARD,
        confirmMxReplacement: inboundMxOverridePhrase(inboundDomain),
      }),
    ).resolves.toMatchObject({ state: "pending" });
    expect(await recipientsOf(fixture)).toEqual([inboundDomain]);
  });

  it("treats OUR OWN published MX as convergence, not as a conflict", async () => {
    const fixture = await seed();
    fixture.mx.set(`${INBOUND_SUBDOMAIN}.${DOMAIN}`, [
      { exchange: `${US_INBOUND_HOST}.`, priority: INBOUND_MX_PRIORITY },
    ]);

    await expect(
      service(fixture).enable({ domain: DOMAIN, forwardTo: FORWARD }),
    ).resolves.toMatchObject({ state: "verified" });
  });

  it("fails CLOSED when DNS cannot answer", async () => {
    // "We could not check" is not "there is nothing there". The cost of
    // guessing wrong is a deleted mailbox, so an unresolved lookup refuses and
    // says which override would proceed anyway.
    const fixture = await seed();
    fixture.mxError = Object.assign(new Error("queryMx ESERVFAIL"), {
      code: "ESERVFAIL",
    });

    await expect(
      service(fixture).enable({ domain: DOMAIN, forwardTo: FORWARD }),
    ).rejects.toThrow(InboundMxLookupError);
    expect(fixture.inbound.__ruleSetNames()).toEqual([]);
  });

  it("REFUSES to displace a rule set we do not own", async () => {
    // Activating a rule set silently deactivates whatever was active, ACCOUNT
    // WIDE, for every tenant in the region. This is the receiving twin of a
    // cross-tenant leak, and the reason provisioning reads before it writes.
    const fixture = await seed();
    await fixture.inbound.createRuleSet({ ruleSetName: "somebody-elses" });
    await fixture.inbound.setActiveRuleSet({ ruleSetName: "somebody-elses" });

    const error = await service(fixture)
      .enable({ domain: DOMAIN, forwardTo: FORWARD })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ForeignInboundRuleSetError);
    expect((error as Error).message).toContain("somebody-elses");
    // Still active, still theirs, and ours was never even created.
    expect(await fixture.inbound.getActiveRuleSet()).toMatchObject({
      ruleSetName: "somebody-elses",
    });
    expect(fixture.inbound.__ruleSetNames()).toEqual(["somebody-elses"]);
  });

  it("ADOPTS the active rule set when it is ours, without re-activating it", async () => {
    const fixture = await seed();
    await service(fixture).enable({ domain: DOMAIN, forwardTo: FORWARD });
    const activations = () =>
      fixture.inbound.calls.filter((call) => call.method === "setActiveRuleSet")
        .length;
    expect(activations()).toBe(1);

    await service(fixture).enable({ domain: OTHER_DOMAIN, forwardTo: FORWARD });

    // Adoption is a READ. Re-activating an already-active set is a write on a
    // once-per-second-throttled API that can only ever do harm.
    expect(activations()).toBe(1);
    expect(await fixture.inbound.getActiveRuleSet()).toMatchObject({
      ruleSetName: INBOUND_RULE_SET_NAME,
    });
  });

  it("PACKS a second domain into the same rule rather than minting one", async () => {
    const fixture = await seed();
    const inbound = service(fixture);

    await inbound.enable({ domain: DOMAIN, forwardTo: FORWARD });
    await inbound.enable({ domain: OTHER_DOMAIN, forwardTo: FORWARD });

    expect(await ruleNames(fixture)).toEqual([inboundRuleName(1)]);
    expect(await recipientsOf(fixture)).toEqual([
      `${INBOUND_SUBDOMAIN}.${DOMAIN}`,
      `${INBOUND_SUBDOMAIN}.${OTHER_DOMAIN}`,
    ]);
  });

  it("rolls domain 501 into a SECOND rule", async () => {
    // 500 recipients per rule, "Adjustable: No". The 501st cannot wait for a
    // quota increase that does not exist.
    const fixture = await seed();
    await fixture.inbound.createRuleSet({
      ruleSetName: INBOUND_RULE_SET_NAME,
    });
    await fixture.inbound.putRule({
      ruleSetName: INBOUND_RULE_SET_NAME,
      ruleName: inboundRuleName(1),
      recipients: Array.from(
        { length: SES_INBOUND_MAX_RECIPIENTS_PER_RULE },
        (_, index) => `reply.d${index}.test`,
      ),
      store: STORE,
    });

    await service(fixture).enable({ domain: DOMAIN, forwardTo: FORWARD });

    expect(await ruleNames(fixture)).toEqual([
      inboundRuleName(1),
      inboundRuleName(2),
    ]);
    expect(await recipientsOf(fixture, inboundRuleName(2))).toEqual([
      `${INBOUND_SUBDOMAIN}.${DOMAIN}`,
    ]);
    // The full rule is untouched — a re-pack that rewrote it would put 500
    // customers' mail through one throttled call for no reason.
    expect(await recipientsOf(fixture, inboundRuleName(1))).toHaveLength(
      SES_INBOUND_MAX_RECIPIENTS_PER_RULE,
    );
  });

  it("is IDEMPOTENT: enabling twice converges and writes nothing the second time", async () => {
    // PRD 22 exists because a domain flow short-circuited above a required
    // side effect. The re-drive here must converge rather than duplicate, and
    // must not silently skip the steps that make the first run correct.
    const fixture = await seed();
    const inbound = service(fixture);
    await inbound.enable({ domain: DOMAIN, forwardTo: FORWARD });

    const before = fixture.inbound.calls.length;
    await inbound.enable({ domain: DOMAIN, forwardTo: FORWARD });

    expect(await ruleNames(fixture)).toEqual([inboundRuleName(1)]);
    expect(await recipientsOf(fixture)).toEqual([
      `${INBOUND_SUBDOMAIN}.${DOMAIN}`,
    ]);
    // Converged means no WRITE, not no calls: the reads that prove convergence
    // still run, and that is the difference between resumable and skipped.
    const written = fixture.inbound.calls
      .slice(before)
      .filter((call) =>
        ["putRule", "createRuleSet", "setActiveRuleSet"].includes(call.method),
      );
    expect(written).toEqual([]);
  });

  it("stores the forwarding address BEFORE the rule that delivers to it", async () => {
    // The ordering is the promise. A rule written first would have SES
    // accepting replies while the control plane still had nowhere to forward
    // them, and the window is exactly as long as the next failure lasts.
    const fixture = await seed();
    fixture.inbound.failNext("putRule");

    await expect(
      service(fixture).enable({ domain: DOMAIN, forwardTo: FORWARD }),
    ).rejects.toThrow(SesError);

    // Stored anyway, and inert: an address with no rule receives nothing.
    expect(
      await readInboundConfig(
        { environmentId: fixture.environmentId, domain: DOMAIN },
        { db },
      ),
    ).toMatchObject({ forwardTo: FORWARD });
    expect(await ruleNames(fixture)).toEqual([]);
  });

  it("RESUMES after a failure mid-provision rather than duplicating", async () => {
    // PRD 22's property, on this flow: a run that died between two writes must
    // be repairable by running it again, and the re-drive must not mint a
    // second rule or a second recipient for work the first run finished.
    const fixture = await seed();
    fixture.inbound.failNext("putRule");
    await expect(
      service(fixture).enable({ domain: DOMAIN, forwardTo: FORWARD }),
    ).rejects.toThrow(SesError);

    // The re-drive names no address: the first run's stored one carries it.
    await service(fixture).enable({ domain: DOMAIN });

    expect(await ruleNames(fixture)).toEqual([inboundRuleName(1)]);
    expect(await recipientsOf(fixture)).toEqual([
      `${INBOUND_SUBDOMAIN}.${DOMAIN}`,
    ]);
    expect(await fixture.inbound.getActiveRuleSet()).toMatchObject({
      ruleSetName: INBOUND_RULE_SET_NAME,
    });
  });

  it("REPAIRS a rule somebody left disabled instead of reporting it healthy", async () => {
    const fixture = await seed();
    await service(fixture).enable({ domain: DOMAIN, forwardTo: FORWARD });
    await fixture.inbound.putRule({
      ruleSetName: INBOUND_RULE_SET_NAME,
      ruleName: inboundRuleName(1),
      recipients: [`${INBOUND_SUBDOMAIN}.${DOMAIN}`],
      store: STORE,
      enabled: false,
    });
    expect(await service(fixture).get(DOMAIN)).toMatchObject({
      state: "failed",
    });

    await service(fixture).enable({ domain: DOMAIN, forwardTo: FORWARD });

    expect(
      await fixture.inbound.getRule({
        ruleSetName: INBOUND_RULE_SET_NAME,
        ruleName: inboundRuleName(1),
      }),
    ).toMatchObject({ enabled: true });
  });

  it("refuses to touch a console-made rule that already holds the domain", async () => {
    // `putRule` is a REPLACE, so packing into a rule somebody else wrote would
    // delete whatever it carries — an action, a recipient list, a bounce.
    // Enabling and disabling both stop here and say so.
    const fixture = await seed();
    await fixture.inbound.createRuleSet({ ruleSetName: INBOUND_RULE_SET_NAME });
    fixture.inbound.__putForeignRule(INBOUND_RULE_SET_NAME, {
      ruleName: "made-in-the-console",
      recipients: [`${INBOUND_SUBDOMAIN}.${DOMAIN}`],
      enabled: true,
      scanEnabled: true,
      tlsPolicy: "Optional",
      actions: [{ kind: "unsupported", awsType: "BounceAction" }],
    });
    await fixture.inbound.setActiveRuleSet({
      ruleSetName: INBOUND_RULE_SET_NAME,
    });

    await expect(
      service(fixture).enable({ domain: DOMAIN, forwardTo: FORWARD }),
    ).rejects.toThrow(ForeignInboundRuleError);
    await expect(service(fixture).disable(DOMAIN)).rejects.toThrow(
      ForeignInboundRuleError,
    );

    // Untouched, both times.
    expect(
      await fixture.inbound.getRule({
        ruleSetName: INBOUND_RULE_SET_NAME,
        ruleName: "made-in-the-console",
      }),
    ).toMatchObject({
      recipients: [`${INBOUND_SUBDOMAIN}.${DOMAIN}`],
      actions: [{ kind: "unsupported", awsType: "BounceAction" }],
    });
  });

  it("refuses to move a live domain onto a second label", async () => {
    // Honouring it would leave BOTH names receiving, one of them forgotten —
    // and the forgotten one keeps accepting a customer's replies.
    const fixture = await seed();
    const inbound = service(fixture);
    await inbound.enable({ domain: DOMAIN, forwardTo: FORWARD });

    await expect(
      inbound.enable({ domain: DOMAIN, forwardTo: FORWARD, label: "inbox" }),
    ).rejects.toThrow(InboundLabelConflictError);
    expect(await recipientsOf(fixture)).toEqual([
      `${INBOUND_SUBDOMAIN}.${DOMAIN}`,
    ]);
  });

  it("refuses when the region has no inbound bucket and topic configured", async () => {
    // A rule with nowhere to store and nobody to notify is not a rule; it is a
    // silent drop. Absence of configuration is a MODE — inbound is simply off.
    const fixture = await seed();
    const unconfigured = createHogsendInbound(
      { environmentId: fixture.environmentId },
      { db, inbound: fixture.inbound, store: null, lookupMx: async () => [] },
    );

    await expect(
      unconfigured.enable({ domain: DOMAIN, forwardTo: FORWARD }),
    ).rejects.toThrow(InboundNotConfiguredError);
  });

  it("audits the enable with names only", async () => {
    const fixture = await seed();
    await service(fixture).enable({ domain: DOMAIN, forwardTo: FORWARD });

    const rows = await auditRows("email_inbound.enabled");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.at(-1)?.detail).toMatchObject({
      domain: DOMAIN,
      inboundDomain: `${INBOUND_SUBDOMAIN}.${DOMAIN}`,
      ruleName: inboundRuleName(1),
    });
  });
});

// ---------------------------------------------------------------------------
// get / disable
// ---------------------------------------------------------------------------

describe("get", () => {
  it("answers null for a domain nobody enabled, and [] records", async () => {
    // An absent domain is an ordinary state of the world, not an error a UI
    // has to catch — the same call `ses-domains` makes.
    const fixture = await seed();
    expect(await service(fixture).get(DOMAIN)).toBeNull();
    expect(await service(fixture).records(DOMAIN)).toEqual([]);
  });
});

describe("disable", () => {
  it("removes ONLY that domain and leaves the others receiving", async () => {
    const fixture = await seed();
    const inbound = service(fixture);
    await inbound.enable({ domain: DOMAIN, forwardTo: FORWARD });
    await inbound.enable({ domain: OTHER_DOMAIN, forwardTo: FORWARD });

    const status = await inbound.disable(DOMAIN);

    expect(status.state).toBe("not_found");
    expect(status.records).toEqual([]);
    expect(await inbound.get(DOMAIN)).toBeNull();
    expect(await recipientsOf(fixture)).toEqual([
      `${INBOUND_SUBDOMAIN}.${OTHER_DOMAIN}`,
    ]);
    expect(await inbound.records(OTHER_DOMAIN)).toHaveLength(1);
  });

  it("DELETES the last rule rather than leaving it matching everything", async () => {
    // An emptied rule matches "all recipients on all verified domains", so the
    // last disable is the one that could quietly point every other tenant's
    // inbound mail at this bucket.
    const fixture = await seed();
    const inbound = service(fixture);
    await inbound.enable({ domain: DOMAIN, forwardTo: FORWARD });

    await inbound.disable(DOMAIN);

    expect(await ruleNames(fixture)).toEqual([]);
    // The rule set itself STAYS, and stays active: deactivating it is an
    // account-wide switch that would stop every other tenant in the region.
    expect(await fixture.inbound.getActiveRuleSet()).toMatchObject({
      ruleSetName: INBOUND_RULE_SET_NAME,
      rules: [],
    });
  });

  it("forgets the forwarding address, so a re-enable must restate it", async () => {
    const fixture = await seed();
    const inbound = service(fixture);
    await inbound.enable({ domain: DOMAIN, forwardTo: FORWARD });

    await inbound.disable(DOMAIN);

    expect(
      await readInboundConfig(
        { environmentId: fixture.environmentId, domain: DOMAIN },
        { db },
      ),
    ).toBeNull();
    await expect(inbound.enable({ domain: DOMAIN })).rejects.toThrow(
      MissingForwardAddressError,
    );
  });

  it("converges on a domain that was never enabled", async () => {
    const fixture = await seed();
    await expect(service(fixture).disable(DOMAIN)).resolves.toMatchObject({
      state: "not_found",
    });
  });
});

// ---------------------------------------------------------------------------
// The tenant boundary
// ---------------------------------------------------------------------------

/**
 * Receiving has the same shared-account problem the sending side has, one door
 * further along: SES verifies a domain per ACCOUNT, and a receipt rule is
 * written into one shared, account-wide active rule set. So an `enable` that
 * did not ask who owns the domain would let any environment start receiving —
 * and forwarding — another tenant's replies.
 *
 * `disable` is worse, not better: it reads the ACCOUNT-WIDE rule set and
 * rewrites — or DELETES — whichever rules carry the recipients of the domain
 * the caller named. Unguarded, one tenant could stop another tenant's replies
 * arriving, and the failure is silent: nothing bounces, nothing errors, the
 * mail simply stops being received. It shipped without a guard at all.
 *
 * `enable` has NO production caller today (no route, no provisioning step) and
 * the guards are here so that giving either one cannot open this door.
 */
describe("cross-tenant claims", () => {
  it("refuses a domain this organization never added, and writes NOTHING", async () => {
    const fixture = await seed();

    await expect(
      service(fixture).enable({
        domain: UNCLAIMED_DOMAIN,
        forwardTo: FORWARD,
      }),
    ).rejects.toThrow(DomainNotOwnedError);

    // Refused BEFORE the first write, which for inbound means before the
    // account-wide rule set is created or made active — a set activated for a
    // claim we then refused would still displace whatever was receiving.
    await expect(
      fixture.inbound.getRuleSet({ ruleSetName: INBOUND_RULE_SET_NAME }),
    ).rejects.toThrow(SesError);
    expect(await fixture.inbound.getActiveRuleSet()).toEqual({ rules: [] });
    // And no forwarding address is left behind for a domain that never
    // received: a stored address with no rule is inert, but it is also a claim
    // this environment does not have.
    expect(
      await readInboundConfig(
        { environmentId: fixture.environmentId, domain: UNCLAIMED_DOMAIN },
        { db },
      ),
    ).toBeNull();

    // The SAME call for a domain this organization did add still works, so the
    // refusal above is about ownership rather than about a broken fixture.
    await expect(
      service(fixture).enable({ domain: DOMAIN, forwardTo: FORWARD }),
    ).resolves.toMatchObject({ domain: DOMAIN });
  });

  it("refuses another organization's DISABLE, and leaves their mail arriving", async () => {
    // The harm this closes: `disable` rewrites the account-wide rule set for
    // whatever domain it is handed. One tenant could switch off another
    // tenant's inbound mail, and nothing anywhere would report an error.
    //
    // ONE inbound account, because that is the fleet's real shape — the
    // attacker's client must genuinely be able to see and rewrite the victim's
    // rules, or the refusal below would be proving nothing.
    const account = new FakeSesInboundClient({ region: "us" });
    const victim = await seed({
      organizationId: STRANGER_ORG,
      claims: [STRANGER_DOMAIN],
    });
    const attacker = await seed();
    victim.inbound = account;
    attacker.inbound = account;

    await service(victim).enable({
      domain: STRANGER_DOMAIN,
      forwardTo: FORWARD,
    });
    // Precondition: the victim really IS receiving. Without this the
    // assertions below would pass against a rule set that was always empty.
    const before = await account.getRuleSet({
      ruleSetName: INBOUND_RULE_SET_NAME,
    });
    expect(before.rules.flatMap((rule) => rule.recipients)).toContain(
      inboundDomainFor(STRANGER_DOMAIN),
    );

    await expect(service(attacker).disable(STRANGER_DOMAIN)).rejects.toThrow(
      DomainNotOwnedError,
    );

    // NOTHING moved: the same rules, the same recipients, and the victim's
    // forwarding address still on file.
    const after = await account.getRuleSet({
      ruleSetName: INBOUND_RULE_SET_NAME,
    });
    expect(after.rules).toEqual(before.rules);
    expect(
      await readInboundConfig(
        { environmentId: victim.environmentId, domain: STRANGER_DOMAIN },
        { db },
      ),
    ).toMatchObject({ forwardTo: FORWARD });
    // Refused BEFORE the rule set was even read, so a stranger cannot use the
    // call to learn whether a domain is receiving.
    expect(account.calls.filter((c) => c.method === "deleteRule")).toHaveLength(
      0,
    );

    // …and the victim can still turn their own off, so the refusal is about
    // ownership rather than about a rule set nothing could ever change.
    await expect(
      service(victim).disable(STRANGER_DOMAIN),
    ).resolves.toMatchObject({ state: "not_found" });
  });
});

/**
 * `findInboundRecipientOwner` is the tenant boundary of the RECEIVE path: it
 * decides whose reply a message is. It scans, so two environments can both
 * hold a config for one domain — and answering with whichever row the database
 * returned first would hand a second claimant another tenant's replies, and the
 * forwarding address they get delivered to.
 */
describe("findInboundRecipientOwner", () => {
  const CONTESTED = "contested-inbound.test";
  const RECIPIENT = `hello@${INBOUND_SUBDOMAIN}.${CONTESTED}`;

  it("refuses an ambiguous claim rather than picking one", async () => {
    const first = await seed();
    const second = await seed();
    await writeInboundConfig(
      {
        environmentId: first.environmentId,
        domain: CONTESTED,
        config: { forwardTo: FORWARD, label: INBOUND_SUBDOMAIN },
      },
      { db },
    );

    // One claimant: resolved. Without this the assertion below would pass
    // against a resolver that never answers at all.
    expect(await findInboundRecipientOwner(RECIPIENT, { db })).toMatchObject({
      environmentId: first.environmentId,
      domain: CONTESTED,
    });

    await writeInboundConfig(
      {
        environmentId: second.environmentId,
        domain: CONTESTED,
        config: { forwardTo: `someone@${CONTESTED}`, label: INBOUND_SUBDOMAIN },
      },
      { db },
    );

    // Two: nobody. The message is recorded unattributed, which an operator can
    // see and fix; the alternative is a silent interception.
    expect(await findInboundRecipientOwner(RECIPIENT, { db })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

/**
 * `POST /api/email/domains/inbound` — the only way a customer can turn replies
 * on, and off again.
 *
 * Every guard above was unreachable from the product until this endpoint
 * existed, so these tests assert the two things a route can lose that a service
 * test cannot see: that a refusal survives the translation to HTTP with enough
 * in it to act on, and that nothing the caller sends can widen it.
 */

const INBOUND_URL = "http://localhost:3004/api/email/domains/inbound";

function inboundRequest(
  options: { token?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  return new Request(INBOUND_URL, {
    method: "POST",
    headers,
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
}

/** The enable body an ordinary customer sends. */
function enableBody(overrides: Record<string, unknown> = {}) {
  return { domain: DOMAIN, enabled: true, forwardTo: FORWARD, ...overrides };
}

describe("the inbound endpoint", () => {
  it("refuses an anonymous caller, and writes nothing", async () => {
    const fixture = await seed();

    const response = await handleDomainInbound(
      inboundRequest({ body: enableBody() }),
      deps(fixture),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "missing_token" });
    expect(fixture.inbound.__ruleSetNames()).toEqual([]);
  });

  it("returns the MX record the customer has to publish", async () => {
    // An enable the customer cannot act on is useless: the record IS the
    // deliverable, and it names `reply.<domain>` — never the apex, which is
    // where their real company mailbox lives.
    const fixture = await seed();

    const response = await handleDomainInbound(
      inboundRequest({ token: fixture.token, body: enableBody() }),
      deps(fixture),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      enabled: boolean;
      status: {
        state: string;
        records: { type: string; name: string; value: string }[];
      };
    };
    expect(body.enabled).toBe(true);
    expect(body.status.state).toBe("pending");
    expect(body.status.records).toHaveLength(1);
    expect(body.status.records[0]).toMatchObject({
      type: "MX",
      name: `${INBOUND_SUBDOMAIN}.${DOMAIN}`,
      value: US_INBOUND_HOST,
      priority: INBOUND_MX_PRIORITY,
    });
    expect(body.status.records.map((record) => record.name)).not.toContain(
      DOMAIN,
    );
    // …and the address the caller sent really crossed the wire, rather than
    // being dropped by a handler that happened to answer 200.
    expect(
      await readInboundConfig(
        { environmentId: fixture.environmentId, domain: DOMAIN },
        { db },
      ),
    ).toMatchObject({ forwardTo: FORWARD });
  });

  it("REFUSES an enable with no forwarding address, and names what is missing", async () => {
    // Receiving a customer's mail into a database nobody reads is worse than
    // not receiving it. A 500 or a generic "bad request" here would leave the
    // caller with no way to know which field would fix it.
    const fixture = await seed();

    const response = await handleDomainInbound(
      inboundRequest({
        token: fixture.token,
        body: { domain: DOMAIN, enabled: true },
      }),
      deps(fixture),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("inbound_forward_address_required");
    expect(body.message).toContain("forwardTo");
    expect(fixture.inbound.__ruleSetNames()).toEqual([]);
  });

  it("refuses an address that is not one, with the SAME refusal", async () => {
    // One rule decides what a forwarding address is, and it is the service's.
    // A route that pre-validated the format would answer a different code for
    // the same broken configuration.
    const fixture = await seed();

    const response = await handleDomainInbound(
      inboundRequest({
        token: fixture.token,
        body: enableBody({ forwardTo: "support@acme, evil@attacker.test" }),
      }),
      deps(fixture),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "inbound_forward_address_required",
    });
    expect(fixture.inbound.__ruleSetNames()).toEqual([]);
  });

  it("answers 409 carrying the EXACT override phrase when a foreign MX holds the name", async () => {
    // Publishing ours would take somebody else's mail away from them. The
    // refusal has to be distinct from a malformed request AND has to hand back
    // the phrase, or the operator cannot act on it without reading our source.
    const fixture = await seed();
    const inboundDomain = `${INBOUND_SUBDOMAIN}.${DOMAIN}`;
    fixture.mx.set(inboundDomain, [
      { exchange: "aspmx.l.google.com", priority: 1 },
    ]);

    const refused = await handleDomainInbound(
      inboundRequest({ token: fixture.token, body: enableBody() }),
      deps(fixture),
    );

    expect(refused.status).toBe(409);
    const body = (await refused.json()) as {
      error: string;
      message: string;
      confirmMxReplacement: string;
      displacedMx: string[];
    };
    expect(body.error).toBe("inbound_mx_conflict");
    expect(body.confirmMxReplacement).toBe(
      inboundMxOverridePhrase(inboundDomain),
    );
    expect(body.displacedMx).toEqual(["aspmx.l.google.com"]);
    expect(body.message).toContain("aspmx.l.google.com");
    expect(fixture.inbound.__ruleSetNames()).toEqual([]);

    // A near miss is still a miss over the wire: the endpoint may not soften
    // the phrase the service demands.
    const nearMiss = await handleDomainInbound(
      inboundRequest({
        token: fixture.token,
        body: enableBody({ confirmMxReplacement: "yes" }),
      }),
      deps(fixture),
    );
    expect(nearMiss.status).toBe(409);
    expect(fixture.inbound.__ruleSetNames()).toEqual([]);

    // …and the phrase the refusal handed back genuinely works, or the API is
    // demanding a confirmation it then ignores.
    const forced = await handleDomainInbound(
      inboundRequest({
        token: fixture.token,
        body: enableBody({ confirmMxReplacement: body.confirmMxReplacement }),
      }),
      deps(fixture),
    );
    expect(forced.status).toBe(200);
    expect(await recipientsOf(fixture)).toEqual([inboundDomain]);
  });

  it("turns receiving off again over the same endpoint", async () => {
    const fixture = await seed();
    await handleDomainInbound(
      inboundRequest({ token: fixture.token, body: enableBody() }),
      deps(fixture),
    );

    const response = await handleDomainInbound(
      inboundRequest({
        token: fixture.token,
        body: { domain: DOMAIN, enabled: false },
      }),
      deps(fixture),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      enabled: false,
      status: { state: "not_found", records: [] },
    });
    expect(await ruleNames(fixture)).toEqual([]);
  });

  it("refuses another organization's DISABLE, and leaves their mail arriving", async () => {
    // `disable` rewrites the ACCOUNT-WIDE rule set for whatever domain it is
    // handed, so an endpoint that skipped the ownership deed would let any
    // relay token switch off another customer's replies — silently.
    //
    // ONE inbound account, because that is the fleet's real shape: the
    // attacker's client must genuinely be able to see and rewrite the victim's
    // rules, or the refusal below would prove nothing.
    const account = new FakeSesInboundClient({ region: "us" });
    const victim = await seed({
      organizationId: STRANGER_ORG,
      claims: [STRANGER_DOMAIN],
    });
    const attacker = await seed();
    victim.inbound = account;
    attacker.inbound = account;
    await handleDomainInbound(
      inboundRequest({
        token: victim.token,
        body: enableBody({ domain: STRANGER_DOMAIN }),
      }),
      deps(victim),
    );
    const before = await account.getRuleSet({
      ruleSetName: INBOUND_RULE_SET_NAME,
    });
    expect(before.rules.flatMap((rule) => rule.recipients)).toContain(
      inboundDomainFor(STRANGER_DOMAIN),
    );

    const response = await handleDomainInbound(
      inboundRequest({
        token: attacker.token,
        body: { domain: STRANGER_DOMAIN, enabled: false },
      }),
      deps(attacker),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "domain_not_owned" });
    // NOTHING moved, and the rule set was never even rewritten.
    expect(
      (await account.getRuleSet({ ruleSetName: INBOUND_RULE_SET_NAME })).rules,
    ).toEqual(before.rules);
    expect(
      account.calls.filter((call) => call.method === "deleteRule"),
    ).toHaveLength(0);
  });

  it("fails CLOSED when SES refuses mid-write", async () => {
    // A 200 here would tell a customer their replies are live while SES holds
    // no rule at all. 503 because the refusal is transient and nothing was
    // written, so a retry is safe.
    const fixture = await seed();
    fixture.inbound.failNext("putRule");

    const response = await handleDomainInbound(
      inboundRequest({ token: fixture.token, body: enableBody() }),
      deps(fixture),
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(503);
    expect(await ruleNames(fixture)).toEqual([]);
  });

  it("fails CLOSED on a failure NOTHING maps", async () => {
    // The failure translation is a list of kinds it recognises, and the list
    // will always be shorter than reality — a bug in this repo, a driver, a
    // future SDK. Whatever falls off the end must still be a refusal: a
    // catch-all that answered 200 would report every unknown failure as
    // "receiving is on".
    const fixture = await seed();
    const inbound = new Proxy(fixture.inbound, {
      get(target, property, receiver) {
        if (property === "putRule") {
          return async () => {
            throw new Error("nothing maps this");
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const response = await handleDomainInbound(
      inboundRequest({ token: fixture.token, body: enableBody() }),
      { ...deps(fixture), inbound },
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "domains_failed" });
    expect(await ruleNames(fixture)).toEqual([]);
  });

  it("refuses a body that names anything of its own", async () => {
    // The environment is the TOKEN's, never the body's. A caller that could
    // name its own environment would make tenant isolation advisory.
    const fixture = await seed();

    const response = await handleDomainInbound(
      inboundRequest({
        token: fixture.token,
        body: enableBody({ environmentId: "somebody-else" }),
      }),
      deps(fixture),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(fixture.inbound.__ruleSetNames()).toEqual([]);
  });

  it("refuses a disable that smuggles an enable's fields", async () => {
    const fixture = await seed();

    const response = await handleDomainInbound(
      inboundRequest({
        token: fixture.token,
        body: { domain: DOMAIN, enabled: false, forwardTo: FORWARD },
      }),
      deps(fixture),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
  });

  it("refuses a label DNS cannot represent, before anything reaches SES", async () => {
    // `inboundDomainFor` throws a plain Error for a bad label, which the
    // failure translation can only answer 502 to. The schema is what makes it
    // a 400 the caller can read.
    const fixture = await seed();

    const response = await handleDomainInbound(
      inboundRequest({
        token: fixture.token,
        body: enableBody({ label: "reply.acme" }),
      }),
      deps(fixture),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(fixture.inbound.__ruleSetNames()).toEqual([]);
  });

  it("is wired to the route handler", async () => {
    // Through the real route file, with NO injected seams: the process-wide
    // inbound client (the Fake, since the suite runs with no AWS credentials)
    // and the process-wide database. The ownership deed is checked before the
    // store or DNS is consulted, so this reaches neither.
    const fixture = await seed();

    const response = await inboundRoute(
      inboundRequest({
        token: fixture.token,
        body: enableBody({ domain: UNCLAIMED_DOMAIN }),
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "domain_not_owned" });
  });
});
