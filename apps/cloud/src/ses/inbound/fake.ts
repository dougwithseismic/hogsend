import type { SubstrateRegion } from "../../substrate/types";
import { resolveSesRegion } from "../contract";
import { SesError, type SesRegion } from "../types";
import {
  assertPutRuleInput,
  assertRuleName,
  assertRuleSetName,
  resolveSesInboundEndpoint,
  type SesInboundClient,
  type SesInboundVerb,
} from "./contract";
import {
  SES_INBOUND_DEFAULT_ENABLED,
  SES_INBOUND_DEFAULT_SCAN_ENABLED,
  SES_INBOUND_DEFAULT_TLS_POLICY,
  SES_INBOUND_MAX_RULE_SETS,
  SES_INBOUND_MAX_RULES_PER_RULE_SET,
  type SesInboundAction,
  type SesInboundActiveRuleSet,
  type SesInboundPutRuleInput,
  type SesInboundRule,
  type SesInboundRuleRef,
  type SesInboundRuleSet,
  type SesInboundRuleSetRef,
  type SesInboundSetActiveInput,
} from "./types";

/**
 * The in-memory SES INBOUND client: every control-plane test and all of local
 * dev.
 *
 * DETERMINISTIC by construction, and more easily than its outbound sibling:
 * there is no clock here at ALL. AWS's `ReceiptRuleSetMetadata` carries a
 * `CreatedTimestamp` and this seam deliberately does not, so nothing in this
 * file has a timestamp to invent.
 *
 * It is STATEFUL because the interesting facts about inbound are transitions,
 * not return values. Three of them are modelled because getting each one wrong
 * is a production outage that every offline test would certify green:
 *
 *  1. **Only ONE rule set is active per account per region.** "You can define
 *     multiple rule sets for your AWS account, but only one rule set is active
 *     at any time." Activating ours DEACTIVATES whatever was active — for every
 *     tenant in the region at once. A Fake that let two be active would let a
 *     provisioner ship that silently stops another customer's mail.
 *  2. **The active rule set cannot be deleted.** "The currently active rule set
 *     cannot be deleted", so teardown is deactivate-then-delete and a Fake that
 *     deleted anyway would let a teardown ship that 400s on its first real run.
 *  3. **A rule is created DISABLED unless told otherwise.** `Enabled` defaults
 *     to false at AWS. A rule created disabled exists, reads back cleanly and
 *     drops every reply on the floor with no error anywhere, so this seam sends
 *     the field on every write and the Fake stores exactly what it was sent.
 *
 * Two rules here REFUSE what AWS accepts, and both are marked where they live
 * (`assertRecipients`, `assertStoreAction` in `contract.ts`). They are enforced
 * by BOTH implementations, so this is a seam rule rather than a Fake that
 * disagrees with the wire — which would be the PRD 14 failure in reverse.
 *
 * Where AWS's answer could not be learned without running the API, the comment
 * says UNVERIFIED and names what was assumed. An honest "we do not know" beats
 * a confident guess; the live check settles it.
 *
 * Affordances mirror `FakeSesClient`: `failNext`, `calls`, `reset()`, and a
 * `__`-prefixed poke that production code must never call.
 */

export const FAKE_SES_INBOUND_ID = "fake";

export type FakeSesInboundMethod = SesInboundVerb;

export interface FakeSesInboundCall {
  method: FakeSesInboundMethod;
  args: unknown[];
}

export interface FakeSesInboundClientOptions {
  region: SubstrateRegion;
}

export class FakeSesInboundClient implements SesInboundClient {
  readonly id = FAKE_SES_INBOUND_ID;
  readonly region: SubstrateRegion;
  readonly awsRegion: SesRegion;
  readonly inboundEndpoint: string;

  /** Every call made, in order. Cleared with `reset()`. */
  readonly calls: FakeSesInboundCall[] = [];

  /** Rule sets by name; the array is the EVALUATION ORDER, so an update
   * replaces in place and never appends. */
  private readonly ruleSets = new Map<string, SesInboundRule[]>();
  /** The single account-wide switch. `null` = receiving is off entirely. */
  private activeRuleSetName: string | null = null;
  private readonly scriptedFailures = new Map<
    FakeSesInboundMethod,
    SesError[]
  >();

  constructor(options: FakeSesInboundClientOptions) {
    // Both guards, in the same order the AWS client applies them: the substrate
    // mapping first, then inbound availability, which is its OWN lookup.
    this.awsRegion = resolveSesRegion(options.region);
    this.inboundEndpoint = resolveSesInboundEndpoint(this.awsRegion);
    this.region = options.region;
  }

  // -- Test affordances -----------------------------------------------------

  failNext(method: FakeSesInboundMethod, error?: SesError): this {
    const queue = this.scriptedFailures.get(method) ?? [];
    queue.push(
      error ??
        new SesError(`fake SES inbound: scripted failure in ${method}`, {
          kind: "transient",
          operation: method,
        }),
    );
    this.scriptedFailures.set(method, queue);
    return this;
  }

  reset(): this {
    this.ruleSets.clear();
    this.scriptedFailures.clear();
    this.calls.length = 0;
    // The active pointer too: a suite whose previous test left a rule set
    // active would otherwise inherit an account that is already receiving.
    this.activeRuleSetName = null;
    return this;
  }

  /**
   * Seed a rule VERBATIM, bypassing every precondition.
   *
   * The state a console, another tool or a future PRD leaves behind — a rule
   * with a bounce action, or with no recipients at all. `putRule` cannot
   * produce it, and a reconciler has to be tested against it, because the
   * dangerous case is not the rule we wrote but the one we did not.
   */
  __putForeignRule(ruleSetName: string, rule: SesInboundRule): this {
    const rules = this.mustGetRuleSet(ruleSetName);
    const index = rules.findIndex((held) => held.ruleName === rule.ruleName);
    if (index < 0) rules.push(cloneRule(rule));
    else rules[index] = cloneRule(rule);
    return this;
  }

  /** Which rule sets exist, by name. Test-only. */
  __ruleSetNames(): string[] {
    return [...this.ruleSets.keys()];
  }

  // -- Rule set -------------------------------------------------------------

  async createRuleSet(input: SesInboundRuleSetRef): Promise<void> {
    this.record("createRuleSet", [input]);
    assertRuleSetName(input.ruleSetName);
    if (this.ruleSets.has(input.ruleSetName)) {
      // `AlreadyExists`, and NOT swallowed the way the outbound `createTenant`
      // swallows its own: a rule set that already exists may be somebody
      // else's, and may be the ACTIVE one.
      throw alreadyExists("Receipt rule set", input.ruleSetName);
    }
    if (this.ruleSets.size >= SES_INBOUND_MAX_RULE_SETS) {
      // "Maximum number of receipt rule sets per AWS account: 40. Adjustable:
      // No." A QUOTA, so `invalid` and not retryable — waiting does not create
      // room. This is the hard ceiling on any rule-set-per-tenant design.
      throw limitExceeded(
        `an AWS account holds at most ${SES_INBOUND_MAX_RULE_SETS} receipt rule sets`,
      );
    }
    this.ruleSets.set(input.ruleSetName, []);
  }

  async getRuleSet(input: SesInboundRuleSetRef): Promise<SesInboundRuleSet> {
    this.record("getRuleSet", [input]);
    return {
      ruleSetName: input.ruleSetName,
      rules: this.mustGetRuleSet(input.ruleSetName).map(cloneRule),
    };
  }

  async deleteRuleSet(input: SesInboundRuleSetRef): Promise<void> {
    this.record("deleteRuleSet", [input]);
    if (input.ruleSetName === this.activeRuleSetName) {
      // Documented verbatim: "The currently active rule set cannot be deleted."
      // Teardown is deactivate-THEN-delete, and this is the refusal that makes
      // a teardown which forgot that fail HERE rather than on its first real
      // run.
      throw cannotDelete(
        `receipt rule set "${input.ruleSetName}" is the ACTIVE one; deactivate it (setActiveRuleSet) before deleting`,
      );
    }
    if (!this.ruleSets.has(input.ruleSetName)) {
      // SETTLED against live AWS on 2026-08-11, and the documented reading was
      // WRONG. `DeleteReceiptRuleSet` lists exactly one error, `CannotDelete`,
      // whose own description reads "a resource could not be deleted because no
      // resource with the specified name exists" — which reads like a refusal
      // and is not one. A probe deleted a rule set that had never existed and
      // AWS answered 200.
      //
      // So the delete is IDEMPOTENT and returns here rather than throwing.
      // Modelling it as a refusal would have broken exactly the case teardown
      // depends on: a re-drive after a partial failure, where the set is
      // already gone. Note the refusal ABOVE is real and still applies — the
      // ACTIVE set genuinely cannot be deleted.
      return;
    }
    // "...and all of the receipt rules it contains."
    this.ruleSets.delete(input.ruleSetName);
  }

  // -- The one active rule set ----------------------------------------------

  async getActiveRuleSet(): Promise<SesInboundActiveRuleSet> {
    this.record("getActiveRuleSet", []);
    if (this.activeRuleSetName === null) {
      // UNVERIFIED against live AWS: `DescribeActiveReceiptRuleSet` documents
      // no errors and does not say what it answers with nothing active. Modelled
      // as "no name, no rules" rather than a throw, because that is a shape a
      // caller can branch on and a throw would make "receiving is off" look
      // like a fault.
      return { rules: [] };
    }
    return {
      ruleSetName: this.activeRuleSetName,
      rules: this.mustGetRuleSet(this.activeRuleSetName).map(cloneRule),
    };
  }

  async setActiveRuleSet(input: SesInboundSetActiveInput): Promise<void> {
    this.record("setActiveRuleSet", [input]);
    if (input.ruleSetName === null) {
      // "To disable your email-receiving through Amazon SES completely, you can
      // call this operation with RuleSetName set to null." The rule sets stay;
      // nothing is receiving.
      this.activeRuleSetName = null;
      return;
    }
    assertRuleSetName(input.ruleSetName);
    this.mustGetRuleSet(input.ruleSetName);
    // A REPLACE, and this single assignment is the model of the whole
    // constraint: whatever was active is now not, silently, account-wide.
    this.activeRuleSetName = input.ruleSetName;
  }

  // -- Rule ------------------------------------------------------------------

  async putRule(input: SesInboundPutRuleInput): Promise<void> {
    this.record("putRule", [input]);
    assertPutRuleInput(input);
    const rules = this.mustGetRuleSet(input.ruleSetName);

    const rule: SesInboundRule = {
      ruleName: input.ruleName,
      recipients: [...input.recipients],
      // Stored as SENT, never as AWS would default it: the seam's defaults are
      // applied here so the Fake and the wire agree on what a bare put means.
      enabled: input.enabled ?? SES_INBOUND_DEFAULT_ENABLED,
      scanEnabled: input.scanEnabled ?? SES_INBOUND_DEFAULT_SCAN_ENABLED,
      tlsPolicy: input.tlsPolicy ?? SES_INBOUND_DEFAULT_TLS_POLICY,
      actions: [{ kind: "store", ...input.store }],
    };

    const index = rules.findIndex((held) => held.ruleName === input.ruleName);
    if (index < 0) {
      if (rules.length >= SES_INBOUND_MAX_RULES_PER_RULE_SET) {
        // "Maximum number of rules per receipt rule set: 200. Adjustable: No."
        // The ceiling on the one-shared-rule-set design, as 40 is the ceiling
        // on the set-per-tenant one.
        throw limitExceeded(
          `a receipt rule set holds at most ${SES_INBOUND_MAX_RULES_PER_RULE_SET} rules`,
        );
      }
      rules.push(rule);
      return;
    }
    // In PLACE. Rules are evaluated "in the order you've defined", so an update
    // that removed-and-appended would silently reorder a live mail path. And it
    // REPLACES rather than merges, because `UpdateReceiptRule` takes a whole
    // `ReceiptRule` — an omitted field is a reset, not a keep.
    rules[index] = rule;
  }

  async getRule(input: SesInboundRuleRef): Promise<SesInboundRule> {
    this.record("getRule", [input]);
    const rules = this.mustGetRuleSet(input.ruleSetName);
    const rule = rules.find((held) => held.ruleName === input.ruleName);
    if (!rule) throw notFound("Receipt rule", input.ruleName);
    return cloneRule(rule);
  }

  async deleteRule(input: SesInboundRuleRef): Promise<void> {
    this.record("deleteRule", [input]);
    assertRuleName(input.ruleName);
    const rules = this.mustGetRuleSet(input.ruleSetName);
    const index = rules.findIndex((held) => held.ruleName === input.ruleName);
    // A MISSING RULE IS NOT AN ERROR — the asymmetry is AWS's, not ours.
    // `DescribeReceiptRule` documents both `RuleDoesNotExist` and
    // `RuleSetDoesNotExist`; `DeleteReceiptRule` documents ONLY
    // `RuleSetDoesNotExist`, with no rule-missing error at all, which makes
    // teardown naturally re-drivable.
    //
    // UNVERIFIED against live AWS: read off the documented error list rather
    // than observed. A teardown must tolerate BOTH answers, and if a live run
    // shows a throw this line is the first thing to change.
    if (index >= 0) rules.splice(index, 1);
  }

  // -- Internals ------------------------------------------------------------

  /** Log the call, THEN honour a scripted failure — a retry assertion needs
   * the failed attempt in the log, not only the one that worked. */
  private record(method: FakeSesInboundMethod, args: unknown[]): void {
    this.calls.push({ method, args });
    const failure = this.scriptedFailures.get(method)?.shift();
    if (failure) throw failure;
  }

  private mustGetRuleSet(ruleSetName: string): SesInboundRule[] {
    const rules = this.ruleSets.get(ruleSetName);
    if (!rules) throw notFound("Receipt rule set", ruleSetName);
    return rules;
  }
}

/** Deep enough that a caller mutating what it read cannot reach into the
 * Fake's state — the arrays are the only reference types on a rule. */
function cloneRule(rule: SesInboundRule): SesInboundRule {
  return {
    ...rule,
    recipients: [...rule.recipients],
    actions: rule.actions.map((action): SesInboundAction => ({ ...action })),
  };
}

function notFound(resource: string, id: string): SesError {
  return new SesError(`fake SES inbound: ${resource} "${id}" does not exist`, {
    kind: "not_found",
  });
}

function alreadyExists(resource: string, id: string): SesError {
  return new SesError(`fake SES inbound: ${resource} "${id}" already exists`, {
    kind: "already_exists",
  });
}

/** AWS's `LimitExceeded`: a quota, so permanent. Waiting creates no room. */
function limitExceeded(message: string): SesError {
  return new SesError(`fake SES inbound: ${message}`, { kind: "invalid" });
}

/** AWS's `CannotDelete`. Permanent until the caller changes something. */
function cannotDelete(message: string): SesError {
  return new SesError(`fake SES inbound: ${message}`, { kind: "invalid" });
}
