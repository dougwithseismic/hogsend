import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AwsSesInboundClient,
  classifySesInboundError,
} from "../ses/inbound/aws";
import {
  resolveSesInboundEndpoint,
  SES_INBOUND_VERBS,
} from "../ses/inbound/contract";
import { FAKE_SES_INBOUND_ID, FakeSesInboundClient } from "../ses/inbound/fake";
import {
  getFakeSesInboundClient,
  getSesInboundClient,
  resetSesInboundClients,
} from "../ses/inbound/index";
import type { SesInboundPutRuleInput } from "../ses/inbound/types";
import {
  SES_INBOUND_MAX_RECIPIENTS_PER_RULE,
  SES_INBOUND_MAX_RULE_SETS,
  SES_INBOUND_MAX_RULES_PER_RULE_SET,
} from "../ses/inbound/types";
import { SesError } from "../ses/types";

/**
 * The INBOUND seam's Fake, held to the same bar as the outbound one.
 *
 * PRD 14 found ten places where green tests asserted things SES does not do,
 * and PRD 21 found more. Every rule below is therefore traced to a primary
 * source — the SES **v1** API reference (`ses/latest/APIReference`), the
 * developer guide, or the service-quotas page — and the handful of answers we
 * could not learn without running the API are marked UNVERIFIED where they are
 * modelled rather than silently invented.
 *
 * Nothing here reaches AWS. The `AwsSesInboundClient` cases drive an injected
 * in-memory transport and assert the COMMAND SHAPE, which is the only part of
 * the real client a test can honestly check offline.
 */

const RULE_SET = "hogsend-inbound";
const RULE = "reply.acme.test";
const BUCKET = "hogsend-ses-inbound";
const TOPIC = "arn:aws:sns:us-east-1:000000000000:hogsend-ses-inbound";

function putRule(
  overrides: Partial<SesInboundPutRuleInput> = {},
): SesInboundPutRuleInput {
  return {
    ruleSetName: RULE_SET,
    ruleName: RULE,
    recipients: ["reply.acme.test"],
    store: {
      bucketName: BUCKET,
      topicArn: TOPIC,
      objectKeyPrefix: "inbound/",
    },
    ...overrides,
  };
}

function fake(): FakeSesInboundClient {
  return new FakeSesInboundClient({ region: "us" });
}

async function ruleSetFake(): Promise<FakeSesInboundClient> {
  const client = fake();
  await client.createRuleSet({ ruleSetName: RULE_SET });
  return client;
}

describe("resolveSesInboundEndpoint", () => {
  it("resolves the inbound MX host for both of this stack's regions", () => {
    // AWS General Reference, "Email Receiving endpoints"
    // (`general/latest/gr/ses.html#ses_inbound_endpoints`). This is the host a
    // customer's `reply.<domain>` MX record must point at, so a wrong value
    // here is mail that silently never arrives.
    expect(resolveSesInboundEndpoint("us-east-1")).toBe(
      "inbound-smtp.us-east-1.amazonaws.com",
    );
    expect(resolveSesInboundEndpoint("eu-west-1")).toBe(
      "inbound-smtp.eu-west-1.amazonaws.com",
    );
  });

  it("is its OWN lookup, not a claim about any sending region", () => {
    // Inbound availability is a STRICT SUBSET of sending availability: SES
    // sends from 29 regions and receives in 22. `eu-central-2`, `ap-south-2`,
    // `ap-southeast-5`, `ca-west-1` and `me-central-1` are in the sending
    // table and absent from the receiving one, and AWS states verbatim that
    // "Amazon SES does not support email receiving in the following Regions:
    // AWS GovCloud (US-West) and AWS GovCloud (US-East)".
    //
    // So a region this stack can SEND from is not evidence it can RECEIVE,
    // and the resolver must refuse rather than compose a plausible hostname.
    for (const region of [
      "eu-central-2",
      "ca-west-1",
      "me-central-1",
      "us-gov-west-1",
      "",
      "us",
    ]) {
      const error = (() => {
        try {
          resolveSesInboundEndpoint(region);
          return undefined;
        } catch (thrown) {
          return thrown;
        }
      })();
      expect(
        error,
        `expected ${JSON.stringify(region)} to be refused`,
      ).toBeInstanceOf(SesError);
      expect((error as SesError).kind).toBe("invalid");
    }
  });
});

describe("the SES inbound contract surface", () => {
  it("is exactly EIGHT verbs, and both implementations answer all of them", () => {
    // Deliberately NOT bolted onto the frozen nineteen-verb `SesClient`. Every
    // receipt-rule verb lives in SES **v1** (`@aws-sdk/client-ses`) — the v2
    // action list contains no receipt-rule operation of any kind — so one
    // contract standing for both would mean one seam over two APIs with
    // different clients, different error vocabularies and different regional
    // availability.
    expect(SES_INBOUND_VERBS).toHaveLength(8);
    expect(new Set(SES_INBOUND_VERBS).size).toBe(8);

    const implementations = [
      new FakeSesInboundClient({ region: "us" }),
      new AwsSesInboundClient({ region: "us", send: async () => ({}) }),
    ];
    for (const client of implementations) {
      for (const verb of SES_INBOUND_VERBS) {
        expect(typeof client[verb], `${client.id}.${verb}`).toBe("function");
      }
    }
  });

  it("reports the region pair AND the inbound endpoint on every client", () => {
    const client = new FakeSesInboundClient({ region: "eu" });
    expect(client.id).toBe(FAKE_SES_INBOUND_ID);
    expect(client.region).toBe("eu");
    expect(client.awsRegion).toBe("eu-west-1");
    expect(client.inboundEndpoint).toBe("inbound-smtp.eu-west-1.amazonaws.com");
  });

  it("rejects a region outside the substrate mapping at construction", () => {
    expect(
      () => new FakeSesInboundClient({ region: "ap-south-1" as "us" }),
    ).toThrow(SesError);
  });
});

describe("FakeSesInboundClient rule sets", () => {
  it("creates an EMPTY rule set and reports a duplicate as already_exists", async () => {
    // `CreateReceiptRuleSet` "Creates an empty receipt rule set" and documents
    // `AlreadyExists` — so, unlike the outbound `createTenant`, this is NOT
    // idempotent. A resumed provision branches on `kind`.
    const client = await ruleSetFake();
    expect(await client.getRuleSet({ ruleSetName: RULE_SET })).toEqual({
      ruleSetName: RULE_SET,
      rules: [],
    });

    await expect(
      client.createRuleSet({ ruleSetName: RULE_SET }),
    ).rejects.toMatchObject({ kind: "already_exists" });
  });

  it("refuses a rule set name AWS's own charset refuses", async () => {
    // `CreateReceiptRuleSet`, verbatim: the name must "Contain only ASCII
    // letters (a-z, A-Z), numbers (0-9), underscores (_), or dashes (-)",
    // "Start and end with a letter or number", and "Contain 64 characters or
    // fewer". NOTE the asymmetry with a receipt RULE, whose charset also
    // allows periods — so `reply.acme.com` is a legal rule name and an ILLEGAL
    // rule set name, which is exactly the mistake a domain-derived name makes.
    const client = fake();
    for (const bad of [
      "reply.acme.test",
      "-lead",
      "trail_",
      "",
      "a".repeat(65),
    ]) {
      await expect(
        client.createRuleSet({ ruleSetName: bad }),
        `expected ${JSON.stringify(bad)} to be refused`,
      ).rejects.toMatchObject({ kind: "invalid" });
    }
    // The boundary is 64 INCLUSIVE, not 63.
    await client.createRuleSet({ ruleSetName: "a".repeat(64) });
  });

  it("enforces the 40-rule-set account quota, as a quota not a throttle", async () => {
    // Service quotas → Email receiving: "Maximum number of receipt rule sets
    // per AWS account: 40. Adjustable: No." A rule-set-per-tenant design hits
    // this wall at the 41st tenant, so the Fake has to be able to show it.
    const client = fake();
    for (let index = 0; index < SES_INBOUND_MAX_RULE_SETS; index += 1) {
      await client.createRuleSet({ ruleSetName: `set-${index}` });
    }

    const error = await client
      .createRuleSet({ ruleSetName: "one-too-many" })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SesError);
    // `LimitExceeded` is a QUOTA. Waiting does not create room, so it must not
    // be retryable — the same call the outbound seam makes for its own
    // `LimitExceededException`.
    expect((error as SesError).kind).toBe("invalid");
    expect((error as SesError).retryable).toBe(false);
    // Refused means NOT created: the account is left at the quota, not over it.
    expect(client.__ruleSetNames()).toHaveLength(SES_INBOUND_MAX_RULE_SETS);
  });

  it("refuses to delete a rule set that is not there (UNVERIFIED reading)", async () => {
    // Pinned so the Fake's choice is visible rather than incidental, and stated
    // honestly: `DeleteReceiptRuleSet` documents exactly ONE error,
    // `CannotDelete`, whose own description reads "a resource could not be
    // deleted because no resource with the specified name exists" — so the
    // missing case is modelled as that refusal. The alternative reading is that
    // AWS deletes idempotently and answers 200. A live run settles it; until
    // then a teardown must not depend on either.
    await expect(
      fake().deleteRuleSet({ ruleSetName: "never-existed" }),
    ).rejects.toMatchObject({ kind: "invalid" });
  });
});

describe("FakeSesInboundClient the ONE active rule set", () => {
  it("reports nothing active until something is activated", async () => {
    const client = await ruleSetFake();

    // UNVERIFIED against live AWS: `DescribeActiveReceiptRuleSet` documents no
    // errors and does not say what it answers when no rule set is active. The
    // Fake reports "no name, no rules" rather than throwing, because that is
    // the shape a caller can branch on; a live run settles it.
    expect(await client.getActiveRuleSet()).toEqual({ rules: [] });
  });

  it("REPLACES the active rule set — only one is active at a time", async () => {
    // The single most dangerous fact about inbound, from the developer guide
    // verbatim: "You can define multiple rule sets for your AWS account, but
    // only one rule set is active at any time."
    //
    // Activating ours therefore DEACTIVATES whatever was active, account-wide
    // and across every tenant in the region. A Fake that let two sets be
    // active would certify a provisioner that silently stops another
    // customer's mail.
    const client = await ruleSetFake();
    await client.createRuleSet({ ruleSetName: "other" });
    await client.putRule(putRule());

    await client.setActiveRuleSet({ ruleSetName: RULE_SET });
    expect(await client.getActiveRuleSet()).toMatchObject({
      ruleSetName: RULE_SET,
    });
    expect((await client.getActiveRuleSet()).rules).toHaveLength(1);

    await client.setActiveRuleSet({ ruleSetName: "other" });
    expect(await client.getActiveRuleSet()).toEqual({
      ruleSetName: "other",
      rules: [],
    });
    // The displaced set is still THERE — deactivated, not deleted.
    expect(
      (await client.getRuleSet({ ruleSetName: RULE_SET })).rules,
    ).toHaveLength(1);
  });

  it("treats a null name as 'disable ALL email receiving'", async () => {
    // `SetActiveReceiptRuleSet`, verbatim: "To disable your email-receiving
    // through Amazon SES completely, you can call this operation with
    // RuleSetName set to null." The seam takes `string | null` rather than an
    // optional field so that outcome is a value someone typed, never an
    // omission.
    const client = await ruleSetFake();
    await client.setActiveRuleSet({ ruleSetName: RULE_SET });

    await client.setActiveRuleSet({ ruleSetName: null });

    expect(await client.getActiveRuleSet()).toEqual({ rules: [] });
    expect(await client.getRuleSet({ ruleSetName: RULE_SET })).toBeTruthy();
  });

  it("refuses to activate a rule set that does not exist", async () => {
    await expect(
      fake().setActiveRuleSet({ ruleSetName: "nope" }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("refuses to delete the ACTIVE rule set", async () => {
    // `DeleteReceiptRuleSet`, verbatim: "The currently active rule set cannot
    // be deleted." Teardown is therefore deactivate-THEN-delete, and a Fake
    // that deleted anyway would let a teardown ship that 400s on its first
    // real run.
    const client = await ruleSetFake();
    await client.setActiveRuleSet({ ruleSetName: RULE_SET });

    await expect(
      client.deleteRuleSet({ ruleSetName: RULE_SET }),
    ).rejects.toMatchObject({ kind: "invalid" });
    expect(await client.getRuleSet({ ruleSetName: RULE_SET })).toBeTruthy();

    await client.setActiveRuleSet({ ruleSetName: null });
    await client.deleteRuleSet({ ruleSetName: RULE_SET });
    await expect(
      client.getRuleSet({ ruleSetName: RULE_SET }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("deletes the rule set AND every rule inside it", async () => {
    // "Deletes the specified receipt rule set and all of the receipt rules it
    // contains."
    const client = await ruleSetFake();
    await client.putRule(putRule());

    await client.deleteRuleSet({ ruleSetName: RULE_SET });
    await client.createRuleSet({ ruleSetName: RULE_SET });

    expect((await client.getRuleSet({ ruleSetName: RULE_SET })).rules).toEqual(
      [],
    );
  });
});

describe("FakeSesInboundClient rules", () => {
  it("writes the rule ENABLED and SCANNED, which AWS does not default to", async () => {
    // `ReceiptRule` documents `Enabled` and `ScanEnabled` as defaulting to
    // FALSE. A rule created disabled exists, reads back fine, and drops every
    // reply on the floor with no error at any layer — so this seam always
    // sends both explicitly and defaults them ON.
    //
    // (`ScanEnabled` is where AWS contradicts itself: the API reference says
    // the default is false while the developer guide says "By default SES
    // scans received email content for malware". Sending the field on every
    // write is what makes that contradiction unable to bite us.)
    const client = await ruleSetFake();
    await client.putRule(putRule());

    const rule = await client.getRule({
      ruleSetName: RULE_SET,
      ruleName: RULE,
    });
    expect(rule).toEqual({
      ruleName: RULE,
      recipients: ["reply.acme.test"],
      enabled: true,
      scanEnabled: true,
      // AWS's own default, and deliberately NOT hardened to "Require":
      // `Require` BOUNCES mail that did not arrive over TLS, and PRD 16's
      // whole mandate is that a human's reply reaches a human.
      tlsPolicy: "Optional",
      actions: [
        {
          kind: "store",
          bucketName: BUCKET,
          topicArn: TOPIC,
          objectKeyPrefix: "inbound/",
        },
      ],
    });
  });

  it("round-trips an explicitly disabled rule rather than forcing it on", async () => {
    const client = await ruleSetFake();
    await client.putRule(
      putRule({ enabled: false, scanEnabled: false, tlsPolicy: "Require" }),
    );

    expect(
      await client.getRule({ ruleSetName: RULE_SET, ruleName: RULE }),
    ).toMatchObject({
      enabled: false,
      scanEnabled: false,
      tlsPolicy: "Require",
    });
  });

  it("REFUSES a rule with no recipients, which AWS accepts and must not", async () => {
    // This is a SEAM rule that deliberately diverges from AWS, and the reason
    // is the loudest one in the file. `ReceiptRule.Recipients`, verbatim: "If
    // this field is not specified, this rule matches all recipients on all
    // verified domains."
    //
    // On a multi-tenant account that means ONE tenant's rule silently
    // swallowing every other tenant's inbound mail — the receiving twin of the
    // cross-tenant suppression leak the outbound seam exists to prevent. AWS
    // will happily create it; this seam will not, in BOTH implementations.
    const client = await ruleSetFake();

    await expect(
      client.putRule(putRule({ recipients: [] })),
    ).rejects.toMatchObject({ kind: "invalid" });
    // Refused means NOT recorded.
    expect((await client.getRuleSet({ ruleSetName: RULE_SET })).rules).toEqual(
      [],
    );

    await expect(
      new AwsSesInboundClient({
        region: "us",
        send: async () => ({}),
      }).putRule(putRule({ recipients: [] })),
    ).rejects.toMatchObject({ kind: "invalid" });
  });

  it("REFUSES a store action with no SNS topic, which AWS also accepts", async () => {
    // `S3Action.TopicArn` is optional to AWS. To this seam it is not: an S3
    // action with no topic stores the raw MIME and tells nobody, so the reply
    // lands in a bucket no journey ever hears about. Storing mail nobody is
    // notified of is indistinguishable from losing it.
    const client = await ruleSetFake();

    await expect(
      client.putRule(
        putRule({
          store: { bucketName: BUCKET },
        } as Partial<SesInboundPutRuleInput>),
      ),
    ).rejects.toMatchObject({ kind: "invalid" });
  });

  it("enforces AWS's recipient and rule-count quotas", async () => {
    // Service quotas → Email receiving: 500 recipients per receipt rule, 200
    // rules per receipt rule set. Both "Adjustable: No".
    const client = await ruleSetFake();
    const recipients = Array.from(
      { length: SES_INBOUND_MAX_RECIPIENTS_PER_RULE + 1 },
      (_, index) => `r${index}.acme.test`,
    );

    await expect(client.putRule(putRule({ recipients }))).rejects.toMatchObject(
      { kind: "invalid" },
    );

    const bulk = fake();
    await bulk.createRuleSet({ ruleSetName: RULE_SET });
    for (
      let index = 0;
      index < SES_INBOUND_MAX_RULES_PER_RULE_SET;
      index += 1
    ) {
      await bulk.putRule(putRule({ ruleName: `rule-${index}` }));
    }
    await expect(
      bulk.putRule(putRule({ ruleName: "one-too-many" })),
    ).rejects.toMatchObject({ kind: "invalid" });
  });

  it("refuses a rule name outside AWS's charset, which DOES allow periods", async () => {
    // `ReceiptRule.Name`: "Contain only ASCII letters (a-z, A-Z), numbers
    // (0-9), underscores (_), dashes (-), or periods (.)". The period is the
    // difference from a rule SET name, so a domain-shaped rule name is legal
    // here and would be refused there.
    const client = await ruleSetFake();
    await client.putRule(putRule({ ruleName: "reply.acme.test" }));

    for (const bad of [".lead", "trail-", "has space", "", "a".repeat(65)]) {
      await expect(
        client.putRule(putRule({ ruleName: bad })),
        `expected ${JSON.stringify(bad)} to be refused`,
      ).rejects.toMatchObject({ kind: "invalid" });
    }
  });

  it("is a PUT: it upserts in place and keeps rule order", async () => {
    // Same reasoning as the outbound `putEventDestination`. SES v1 offers
    // `CreateReceiptRule` and `UpdateReceiptRule` and no Put, and provisioning
    // has to be resumable, so the create-then-update dance lives on the seam
    // rather than in every caller.
    //
    // Order matters because "all of the receipt rules within your active rule
    // set are applied in the order you've defined" — an update that appended
    // would silently reorder a live mail path.
    const client = await ruleSetFake();
    await client.putRule(putRule({ ruleName: "first" }));
    await client.putRule(putRule({ ruleName: "second" }));

    await client.putRule(
      putRule({ ruleName: "first", recipients: ["updated.acme.test"] }),
    );

    const { rules } = await client.getRuleSet({ ruleSetName: RULE_SET });
    expect(rules.map((rule) => rule.ruleName)).toEqual(["first", "second"]);
    expect(rules[0]?.recipients).toEqual(["updated.acme.test"]);
  });

  it("REPLACES the rule on a put — an omitted field is a reset, not a keep", async () => {
    // `UpdateReceiptRule` takes a whole `ReceiptRule`, so it is a replace. A
    // Fake that merged would let a re-drive which drops `objectKeyPrefix` pass
    // here and quietly re-point the bucket path in production.
    const client = await ruleSetFake();
    await client.putRule(putRule());

    await client.putRule(
      putRule({ store: { bucketName: BUCKET, topicArn: TOPIC } }),
    );

    expect(
      (await client.getRule({ ruleSetName: RULE_SET, ruleName: RULE }))
        .actions[0],
    ).toEqual({ kind: "store", bucketName: BUCKET, topicArn: TOPIC });
  });

  it("reports an action it does not model rather than pretending it is ours", async () => {
    // The PRD 14 lesson applied to the read path. A human can add a bounce or
    // SNS action in the console, and a `getRule` that dropped it would hand a
    // reconciler a rule that looks exactly like the one we wrote. Anything
    // unmodelled comes back NAMED, never silently discarded.
    const client = await ruleSetFake();
    client.__putForeignRule(RULE_SET, {
      ruleName: "console-made",
      recipients: ["acme.test"],
      enabled: true,
      scanEnabled: true,
      tlsPolicy: "Optional",
      actions: [{ kind: "unsupported", awsType: "BounceAction" }],
    });

    expect(
      (
        await client.getRule({
          ruleSetName: RULE_SET,
          ruleName: "console-made",
        })
      ).actions,
    ).toEqual([{ kind: "unsupported", awsType: "BounceAction" }]);
  });

  it("refuses to touch a rule in a rule set that does not exist", async () => {
    const client = fake();

    await expect(client.putRule(putRule())).rejects.toMatchObject({
      kind: "not_found",
    });
    await expect(
      client.getRule({ ruleSetName: RULE_SET, ruleName: RULE }),
    ).rejects.toMatchObject({ kind: "not_found" });
    await expect(
      client.deleteRule({ ruleSetName: RULE_SET, ruleName: RULE }),
    ).rejects.toMatchObject({ kind: "not_found" });
    await expect(
      client.getRuleSet({ ruleSetName: RULE_SET }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("reads a missing rule as not_found but DELETES one idempotently", async () => {
    // The asymmetry is AWS's, not ours. `DescribeReceiptRule` documents both
    // `RuleDoesNotExist` and `RuleSetDoesNotExist`; `DeleteReceiptRule`
    // documents ONLY `RuleSetDoesNotExist` — there is no rule-missing error on
    // the delete at all, which makes teardown naturally re-drivable.
    //
    // UNVERIFIED against live AWS: this is read off the documented error list,
    // not observed. A teardown must therefore tolerate BOTH answers, and if a
    // live run shows a throw this Fake is the first thing to change.
    const client = await ruleSetFake();

    await expect(
      client.getRule({ ruleSetName: RULE_SET, ruleName: "ghost" }),
    ).rejects.toMatchObject({ kind: "not_found" });

    await client.putRule(putRule());
    await client.deleteRule({ ruleSetName: RULE_SET, ruleName: RULE });
    await client.deleteRule({ ruleSetName: RULE_SET, ruleName: RULE });
    expect((await client.getRuleSet({ ruleSetName: RULE_SET })).rules).toEqual(
      [],
    );
  });
});

describe("AwsSesInboundClient command shapes", () => {
  function recorder(): {
    client: AwsSesInboundClient;
    commands: { input: unknown }[];
  } {
    const commands: { input: unknown }[] = [];
    const client = new AwsSesInboundClient({
      region: "us",
      send: async (command) => {
        commands.push(command);
        return {};
      },
    });
    return { client, commands };
  }

  it("sends ONE S3 action carrying the bucket AND the topic", async () => {
    // The action is S3 + SNS, never SNS alone: SES caps an SNS-published
    // message at 150 KB (Adjustable: No) against S3's 40 MB, so an SNS-only
    // rule fails on any real reply carrying a phone photo while passing every
    // test fixture. The rule stores raw MIME in S3 and notifies with the key.
    const { client, commands } = recorder();

    await client.putRule(putRule());

    expect(commands).toHaveLength(1);
    expect(commands[0]?.input).toEqual({
      RuleSetName: RULE_SET,
      Rule: {
        Name: RULE,
        Enabled: true,
        ScanEnabled: true,
        TlsPolicy: "Optional",
        Recipients: ["reply.acme.test"],
        Actions: [
          {
            S3Action: {
              BucketName: BUCKET,
              TopicArn: TOPIC,
              ObjectKeyPrefix: "inbound/",
            },
          },
        ],
      },
    });
  });

  it("falls back to UpdateReceiptRule when the rule already exists", async () => {
    // The `put` half of the verb, and the reason it is a `put` at all: AWS
    // offers create-or-update as two calls, and a re-driven provisioning step
    // must not fail on its own previous success.
    const commands: { input: unknown }[] = [];
    let first = true;
    const client = new AwsSesInboundClient({
      region: "us",
      send: async (command) => {
        commands.push(command);
        if (first) {
          first = false;
          throw Object.assign(new Error("Rule already exists"), {
            name: "AlreadyExistsException",
            $metadata: { httpStatusCode: 400 },
          });
        }
        return {};
      },
    });

    await client.putRule(putRule());

    expect(commands).toHaveLength(2);
    // Both legs carry the same rule body; only the operation differs, and
    // `UpdateReceiptRule` has no `After` field at all — which is why this seam
    // deliberately takes no rule POSITION. Accepting one would honour it on
    // the first write and silently ignore it on every re-drive.
    expect(commands[1]?.input).toEqual(commands[0]?.input);
  });

  it("names the rule set, and only the rule set, when activating", async () => {
    const { client, commands } = recorder();

    await client.setActiveRuleSet({ ruleSetName: RULE_SET });
    await client.setActiveRuleSet({ ruleSetName: null });

    expect(commands[0]?.input).toEqual({ RuleSetName: RULE_SET });
    // `null` disables ALL receiving, and the field is OMITTED rather than sent
    // as an explicit null — AWS's `RuleSetName` is "Required: No", and the
    // query protocol has no null to serialise.
    expect(commands[1]?.input).toEqual({});
  });

  it("reads a rule back honestly, INCLUDING an action it does not model", async () => {
    // The read path, driven with the shape AWS actually answers.
    //
    // Two things are being pinned. First, `Enabled` absent reads as FALSE —
    // AWS's own documented default — because reporting a dead rule as a live
    // one is how "provisioned, receiving nothing" survives a green suite.
    // Second, the second action is NAMED rather than dropped: a rule can hold
    // ten actions and this seam writes one, so everything else arrived from a
    // console or another tool, and a reconciler must be able to see it.
    const client = new AwsSesInboundClient({
      region: "us",
      send: async () => ({
        Rule: {
          Name: RULE,
          Recipients: ["reply.acme.test"],
          TlsPolicy: "Require",
          Actions: [
            {
              S3Action: {
                BucketName: BUCKET,
                TopicArn: TOPIC,
                ObjectKeyPrefix: "inbound/",
              },
            },
            { SNSAction: { TopicArn: TOPIC } },
          ],
        },
      }),
    });

    expect(
      await client.getRule({ ruleSetName: RULE_SET, ruleName: RULE }),
    ).toEqual({
      ruleName: RULE,
      recipients: ["reply.acme.test"],
      enabled: false,
      scanEnabled: false,
      tlsPolicy: "Require",
      actions: [
        {
          kind: "store",
          bucketName: BUCKET,
          topicArn: TOPIC,
          objectKeyPrefix: "inbound/",
        },
        { kind: "unsupported", awsType: "SNSAction" },
      ],
    });
  });

  it("refuses to report a rule AWS did not return", async () => {
    // A 200 with no `Rule` is not a rule. Answering with an empty shell would
    // hand a reconciler a rule named `""` with no actions, which reads exactly
    // like a rule somebody emptied.
    const client = new AwsSesInboundClient({
      region: "us",
      send: async () => ({}),
    });

    await expect(
      client.getRule({ ruleSetName: RULE_SET, ruleName: RULE }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("classifySesInboundError", () => {
  function thrown(name: string, message = "boom"): unknown {
    return Object.assign(new Error(message), {
      name,
      $metadata: { httpStatusCode: 400 },
    });
  }

  it("speaks SES v1's error vocabulary, which is NOT v2's", () => {
    // v1 is the query protocol: the WIRE code is `RuleSetDoesNotExist` while
    // the SDK's modelled class sets `name` to `RuleSetDoesNotExistException`.
    // Which one reaches `error.name` depends on SDK internals we have not
    // observed live, so both spellings are mapped.
    //
    // Without this, every one of these falls through the shared classifier's
    // "unrecognised 4xx" arm and lands on `invalid` — so a teardown asking
    // "is it already gone?" would never see `not_found`.
    expect(classifySesInboundError(thrown("RuleSetDoesNotExist")).kind).toBe(
      "not_found",
    );
    expect(
      classifySesInboundError(thrown("RuleSetDoesNotExistException")).kind,
    ).toBe("not_found");
    expect(classifySesInboundError(thrown("RuleDoesNotExist")).kind).toBe(
      "not_found",
    );
    expect(classifySesInboundError(thrown("AlreadyExists")).kind).toBe(
      "already_exists",
    );
    expect(classifySesInboundError(thrown("AlreadyExistsException")).kind).toBe(
      "already_exists",
    );
  });

  it("keeps a quota permanent and a throttle retryable", () => {
    const quota = classifySesInboundError(thrown("LimitExceeded"));
    expect(quota.kind).toBe("invalid");
    expect(quota.retryable).toBe(false);

    // Every v1 receipt-rule operation is throttled at ONE REQUEST PER SECOND
    // ("You can execute this operation no more than once per second"), so a
    // provisioning burst hits this far sooner than the send path ever does.
    const throttled = classifySesInboundError(thrown("Throttling"));
    expect(throttled.kind).toBe("throttled");
    expect(throttled.retryable).toBe(true);
  });

  it("keeps a misconfigured bucket or topic permanent, and names it", () => {
    // `InvalidS3Configuration` / `InvalidSnsTopic` mean SES could not publish
    // to the resource, "possibly due to permissions issues". Retrying cannot
    // grant a permission, and the body is the only thing that says which
    // resource — so it must survive onto the error.
    const error = classifySesInboundError(
      thrown("InvalidS3Configuration", "Could not write to bucket"),
      "putRule",
    );
    expect(error.kind).toBe("invalid");
    expect(error.retryable).toBe(false);
    expect(error.awsErrorName).toBe("InvalidS3Configuration");
    expect(error.operation).toBe("putRule");
    expect(error.detail).toContain("Could not write to bucket");
  });

  it("still answers the shared classifier for anything v1-specific it is not", () => {
    expect(classifySesInboundError(thrown("Boom", "x")).kind).toBe("invalid");
    expect(
      classifySesInboundError(
        Object.assign(new Error("socket hang up"), { name: "Error" }),
      ).kind,
    ).toBe("transient");
  });
});

describe("FakeSesInboundClient test affordances", () => {
  it("is deterministic: the same script twice yields identical output", async () => {
    const run = async (): Promise<unknown> => {
      const client = fake();
      await client.createRuleSet({ ruleSetName: RULE_SET });
      await client.putRule(putRule());
      await client.setActiveRuleSet({ ruleSetName: RULE_SET });
      return {
        set: await client.getRuleSet({ ruleSetName: RULE_SET }),
        active: await client.getActiveRuleSet(),
        rule: await client.getRule({ ruleSetName: RULE_SET, ruleName: RULE }),
      };
    };

    // No clock, no RNG — and no `createdAt` anywhere on the seam, for the same
    // reason the outbound `SesTenant` has none: carrying AWS's
    // `ReceiptRuleSetMetadata.CreatedTimestamp` would force this Fake to
    // invent a clock, which is the one thing it may not have.
    expect(await run()).toEqual(await run());
  });

  it("scripts exactly one failure with failNext and logs every call", async () => {
    const client = fake();
    client.failNext("createRuleSet");

    const error = await client
      .createRuleSet({ ruleSetName: RULE_SET })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(SesError);
    expect((error as SesError).retryable).toBe(true);

    await client.createRuleSet({ ruleSetName: RULE_SET });
    // The FAILED attempt is in the log too, or a retry assertion would be
    // counting only the call that worked.
    expect(client.calls.map((call) => call.method)).toEqual([
      "createRuleSet",
      "createRuleSet",
    ]);
  });

  it("drops all state on reset, INCLUDING which rule set was active", async () => {
    const client = await ruleSetFake();
    await client.putRule(putRule());
    await client.setActiveRuleSet({ ruleSetName: RULE_SET });

    client.reset();

    expect(client.calls).toEqual([]);
    // The ACTIVE pointer is state too. A suite whose previous test left a rule
    // set active would otherwise inherit an account that is already receiving.
    expect(await client.getActiveRuleSet()).toEqual({ rules: [] });
    await expect(
      client.getRuleSet({ ruleSetName: RULE_SET }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("getSesInboundClient", () => {
  // The composition root, held to the same bar as `getSesClient`: the two ways
  // it goes wrong are silently running the Fake in production (a control plane
  // reporting inbound rules that do not exist) and disagreeing with the
  // OUTBOUND factory about whether AWS is configured at all — which is why both
  // read the same `readSesCredentials`.
  const KEY = "CLOUD_AWS_ACCESS_KEY_ID";
  const SECRET = "CLOUD_AWS_SECRET_ACCESS_KEY";
  let saved: { key?: string; secret?: string };

  beforeEach(() => {
    saved = { key: process.env[KEY], secret: process.env[SECRET] };
    delete process.env[KEY];
    delete process.env[SECRET];
    resetSesInboundClients();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (saved.key === undefined) delete process.env[KEY];
    else process.env[KEY] = saved.key;
    if (saved.secret === undefined) delete process.env[SECRET];
    else process.env[SECRET] = saved.secret;
    resetSesInboundClients();
    vi.restoreAllMocks();
  });

  function logLines(): string[] {
    return vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .filter((line) => line.startsWith("[cloud:ses-inbound]"));
  }

  it("yields the Fake with no credentials, and names the MX host once", () => {
    const client = getSesInboundClient("us");

    expect(client).toBeInstanceOf(FakeSesInboundClient);
    // The MX value is the one fact a customer has to be told correctly, so it
    // is on the boot line rather than derivable from somewhere else.
    expect(logLines()).toEqual([
      "[cloud:ses-inbound] client=fake region=us aws_region=us-east-1 mx=inbound-smtp.us-east-1.amazonaws.com",
    ]);
    // ONE client per region, cached: receipt rule sets are region-scoped and
    // the ACTIVE set is a per-region account-wide switch.
    expect(getSesInboundClient("us")).toBe(client);
    expect(getSesInboundClient("eu")).not.toBe(client);
    expect(logLines()).toHaveLength(2);
  });

  it("yields the AWS client when BOTH credentials are present", () => {
    process.env[KEY] = "AKIAFAKE";
    process.env[SECRET] = "secret";

    expect(getSesInboundClient("us")).toBeInstanceOf(AwsSesInboundClient);
    // And the test helper refuses rather than handing back something that
    // would reach AWS the moment a test poked it.
    expect(() => getFakeSesInboundClient("us")).toThrow(SesError);
  });

  it("refuses to boot on HALF a credential pair, like the outbound factory", () => {
    // Shared with `getSesClient` on purpose: a second copy of this gate could
    // let one seam run the real client while the other ran the Fake, which is
    // a state no error message would explain.
    process.env[KEY] = "AKIAFAKE";

    expect(() => getSesInboundClient("us")).toThrow(SesError);
  });
});
