import { readFileSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import { cloudAuditLog, environments, organizations } from "../db/schema";
import { env } from "../env";
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
import type { InboundConfig } from "../services/ses-inbound-config";
import { readInboundConfig } from "../services/ses-inbound-config";
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
const DOMAIN = "acme-inbound.test";
const OTHER_DOMAIN = "beta-inbound.test";
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
  inbound: FakeSesInboundClient;
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
async function seed(): Promise<Fixture> {
  seq += 1;
  const [row] = await db
    .insert(environments)
    .values({ organizationId: ORG, name: `ses-inbound-${seq}`, kind: "test" })
    .returning();
  if (!row) throw new Error("failed to seed environment");

  await provisionSesTenant(
    { environmentId: row.id },
    { ses: new FakeSesClient({ region: "us" }), snsTopicArn: null },
  );
  return {
    environmentId: row.id,
    inbound: new FakeSesInboundClient({ region: "us" }),
    mx: new Map(),
  };
}

function service(fixture: Fixture) {
  return createHogsendInbound(
    { environmentId: fixture.environmentId },
    {
      db,
      inbound: fixture.inbound,
      store: { bucketName: BUCKET, topicArn: TOPIC },
      // NEVER the real resolver: a suite that reached DNS would be asserting
      // the state of somebody's zone file rather than of this code.
      lookupMx: async (name: string) => {
        if (fixture.mxError) throw fixture.mxError;
        return fixture.mx.get(name) ?? [];
      },
    },
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
  await db.delete(organizations).where(inArray(organizations.id, [ORG]));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();
  await db
    .insert(organizations)
    .values({ id: ORG, name: "SES Inbound Test Org", region: "us" });
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
