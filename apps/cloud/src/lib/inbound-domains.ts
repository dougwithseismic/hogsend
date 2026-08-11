import { resolveMx as nodeResolveMx } from "node:dns/promises";
import type {
  SesInboundRule,
  SesInboundStoreAction,
} from "../ses/inbound/types";
import { SES_INBOUND_MAX_RECIPIENTS_PER_RULE } from "../ses/inbound/types";
import type { SubstrateRegion } from "../substrate/types";
import type { DnsRecord, DnsRecordStatus } from "./sending-domains";
import { MAIL_FROM_LABEL_PATTERN } from "./sending-domains";

/**
 * The inbound-receiving vocabulary (PRD 16), and the two decisions that shape
 * every caller of it.
 *
 * **One: the apex is never the target.** A customer's apex MX is their real
 * company mailbox — Google Workspace, Microsoft 365 — and repointing it at SES
 * does not add replies, it DELETES their company email, silently, with no
 * bounce to us and no way back except their own DNS history. So the record this
 * module emits always names `reply.<domain>`, and {@link inboundDomainFor}
 * refuses every label that would collapse onto the apex. The apex is protected
 * STRUCTURALLY, by never being nameable, rather than by a check somebody could
 * decide to skip.
 *
 * **Two: domains are PACKED into a few rules of one shared, active rule set.**
 * Only one receipt rule set is active per account per region, so a set per
 * tenant was never on offer. A rule matches DOMAINS (`ReceiptRule.Recipients`:
 * "The recipient domains and email addresses that the receipt rule applies to")
 * at 500 per rule and 200 rules per set, and every tenant shares the same
 * action — one bucket, one topic, demultiplexed by recipient in the control
 * plane. That is 100,000 domains per region out of a handful of rules, where a
 * rule per tenant would hit the 200 wall at the 201st customer for no gain.
 *
 * Everything here is a value or a decision over values: no SES client, no
 * database, no clock. The one impure export is {@link resolveInboundMx}, which
 * is the default DNS seam and is injected away in every test.
 */

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * The subdomain replies are received on. `reply.<domain>`, never `<domain>`.
 *
 * A word rather than a config default, because it is also what the customer
 * reads in the record we hand them: `reply.acme.com` says what it is at a
 * glance, and a person pasting it into their DNS panel can see it is not their
 * apex.
 */
export const INBOUND_SUBDOMAIN = "reply";

/**
 * SES's own documented priority for an inbound MX record. There is only one
 * exchange, so the number decides nothing — it is pinned to AWS's value so a
 * customer comparing our record against SES's docs sees the same thing.
 */
export const INBOUND_MX_PRIORITY = 10;

/**
 * The ONE receipt rule set this control plane owns, per account per region.
 *
 * NO period: a rule SET name may not contain one (a rule name may), which is
 * exactly the trap a domain-derived name falls into. And no environment id in
 * it either — the set is shared by every tenant in the region by construction,
 * so a name that implied otherwise would invite somebody to mint a second.
 */
export const INBOUND_RULE_SET_NAME = "hogsend-inbound";

/** Rules are shards of the shared set: `hogsend-inbound-1`, `-2`, … */
const INBOUND_RULE_PREFIX = `${INBOUND_RULE_SET_NAME}-`;

/**
 * Where the raw MIME lands inside the shared bucket. One prefix for everybody,
 * because the recipient — which is in the SNS notification — is what says whose
 * mail it is; a per-tenant prefix would put a customer-derived string into an
 * object key for information the payload already carries.
 *
 * PINNED to `INBOUND_PREFIX` in `scripts/aws-bootstrap-events.sh`, which grants
 * the relay `s3:GetObject` on `<bucket>/<prefix>*` and nothing else. If the two
 * drift, SES stores every reply successfully and the read comes back
 * `AccessDenied` — a failure that appears only once real mail arrives. The
 * parity is asserted in `ses-inbound-domains.test.ts`.
 */
export const INBOUND_OBJECT_KEY_PREFIX = "inbound/";

/** The shard number of one of OUR rules, or `null` for a rule we did not name. */
export function inboundRuleShard(ruleName: string): number | null {
  if (!ruleName.startsWith(INBOUND_RULE_PREFIX)) return null;
  const tail = ruleName.slice(INBOUND_RULE_PREFIX.length);
  // Digits only, no leading zero: `-01` and `-1` must not be two names for one
  // shard, or a re-drive would mint a duplicate rule holding the same domains.
  if (!/^[1-9][0-9]*$/.test(tail)) return null;
  return Number(tail);
}

export function inboundRuleName(shard: number): string {
  return `${INBOUND_RULE_PREFIX}${shard}`;
}

/** The caller asked for an inbound label DNS cannot represent. */
export class InvalidInboundLabelError extends Error {
  readonly code = "invalid_inbound_label";

  constructor(readonly label: string) {
    super(
      `"${label}" is not a valid subdomain label for inbound replies. Use one ` +
        "DNS label: lowercase letters, digits and hyphens, starting and ending " +
        'alphanumeric, 63 characters or fewer (e.g. "reply"). It may not be ' +
        "empty and may not contain a dot — replies are received on a subdomain " +
        "of your domain, never on the domain itself, because your domain's MX " +
        "is your real mailbox.",
    );
    this.name = "InvalidInboundLabelError";
  }
}

/**
 * Validate an inbound label against the SAME rule the branded return path uses
 * (`MAIL_FROM_LABEL_PATTERN`, PRD 15). One pattern, two features: a label that
 * is legal for `send.<domain>` and illegal for `reply.<domain>` would be a
 * difference nobody could explain.
 *
 * Throws rather than falling back to `reply`, because silently substituting a
 * default publishes a record for a name the customer did not ask for and they
 * find out by checking DNS for something that is not there.
 */
export function assertInboundLabel(label: string): string {
  const normalized = label.trim().toLowerCase();
  if (!MAIL_FROM_LABEL_PATTERN.test(normalized)) {
    throw new InvalidInboundLabelError(label);
  }
  return normalized;
}

/**
 * `<label>.<domain>` — the name that receives, and the name the MX record is
 * emitted for.
 *
 * The label is ALWAYS prepended, which is what makes the apex unreachable: the
 * only way for this to return the bare domain would be an empty label, and
 * `assertInboundLabel` refuses one.
 */
export function inboundDomainFor(domain: string, label?: string): string {
  const sub =
    label === undefined ? INBOUND_SUBDOMAIN : assertInboundLabel(label);
  return `${sub}.${domain}`;
}

/**
 * The phrase an operator has to type to publish over somebody else's MX.
 *
 * It NAMES THE DOMAIN, so a confirmation cannot be copied from the domain it
 * was written for onto the next one — which is the whole failure mode a boolean
 * `force: true` has. PRD 16: "unless the operator explicitly overrides with a
 * typed confirmation".
 */
export function inboundMxOverridePhrase(inboundDomain: string): string {
  return `replace the MX for ${inboundDomain}`;
}

// ---------------------------------------------------------------------------
// DNS
// ---------------------------------------------------------------------------

export interface MxRecord {
  exchange: string;
  priority: number;
}

/** The DNS seam. Injected in tests; a suite must never resolve real names. */
export type MxLookup = (name: string) => Promise<MxRecord[]>;

/**
 * The default resolver: real MX records, with "there is no MX here" reported as
 * an empty list rather than an error.
 *
 * `ENODATA` (the name exists, it has no MX) and `ENOTFOUND` (the name does not
 * exist) are the two DEFINITIVE ways of saying "nothing would be displaced", so
 * they are answers, not failures. Anything else — SERVFAIL, a timeout, a
 * refused query — is genuinely "we do not know", and the caller fails closed on
 * it. Collapsing those two cases into one would turn a flaky resolver into a
 * customer's deleted mailbox.
 */
export async function resolveInboundMx(name: string): Promise<MxRecord[]> {
  try {
    return await nodeResolveMx(name);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENODATA" || code === "ENOTFOUND") return [];
    throw error;
  }
}

/** DNS is case-insensitive and a fully-qualified answer carries a root dot. */
function sameHost(a: string, b: string): boolean {
  const normalize = (host: string) =>
    host.trim().toLowerCase().replace(/\.+$/, "");
  return normalize(a) === normalize(b);
}

/**
 * Every exchange at this name that is NOT our own inbound host.
 *
 * Empty means the name is free (or already ours, which is a re-drive reading
 * back the record the customer published). Non-empty means real mail already
 * arrives here and publishing our record would take it away from whoever is
 * receiving it today.
 */
export function foreignMxExchanges(
  records: MxRecord[],
  inboundEndpoint: string,
): string[] {
  return records
    .map((record) => record.exchange)
    .filter((exchange) => !sameHost(exchange, inboundEndpoint));
}

/** Is our own inbound host already published at this name? */
export function inboundMxIsPublished(
  records: MxRecord[],
  inboundEndpoint: string,
): boolean {
  return records.some((record) => sameHost(record.exchange, inboundEndpoint));
}

// ---------------------------------------------------------------------------
// The store action's configuration
// ---------------------------------------------------------------------------

/** Where received mail is stored, and who is told about it. Both required. */
export interface InboundStore {
  bucketName: string;
  topicArn: string;
}

/**
 * Resolve the region's inbound store from environment variables, or `null`.
 *
 * `null` is a MODE, not a misconfiguration — the same posture
 * `resolveSesEventTopics` takes. A control plane with no AWS account has no
 * bucket and no topic, inbound is simply unavailable, and nothing else changes.
 *
 * HALF configured is also `null`, and deliberately: an S3 action with no topic
 * is legal to AWS and writes every reply into a bucket nothing ever reads, so
 * "we have a bucket, let's proceed" is the shape of a silent data loss.
 *
 * The BUCKET is shared across regions and the TOPIC is not, which is AWS's own
 * split: "With the exception of Amazon S3 buckets, all of the AWS resources
 * that you use for receiving email with SES have to be in the same AWS Region
 * as the SES endpoint."
 */
export function resolveInboundStore(
  vars: {
    CLOUD_SES_INBOUND_BUCKET?: string;
    CLOUD_SES_INBOUND_TOPIC_ARN_US?: string;
    CLOUD_SES_INBOUND_TOPIC_ARN_EU?: string;
  },
  region: SubstrateRegion,
): InboundStore | null {
  const bucketName = vars.CLOUD_SES_INBOUND_BUCKET;
  const topicArn =
    region === "us"
      ? vars.CLOUD_SES_INBOUND_TOPIC_ARN_US
      : vars.CLOUD_SES_INBOUND_TOPIC_ARN_EU;
  if (!bucketName || !topicArn) return null;
  return { bucketName, topicArn };
}

/** The store action a rule of ours carries, built from the region's config. */
export function inboundStoreAction(store: InboundStore): SesInboundStoreAction {
  return {
    bucketName: store.bucketName,
    topicArn: store.topicArn,
    objectKeyPrefix: INBOUND_OBJECT_KEY_PREFIX,
  };
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * THE record. One MX at `reply.<domain>`, pointing at the region's SES inbound
 * host — and never anything at the apex.
 *
 * Fully qualified, like the DKIM record next door: it is what the customer
 * pastes and what a `dig` reproduces.
 */
export function inboundMxRecord(input: {
  inboundDomain: string;
  inboundEndpoint: string;
  status: DnsRecordStatus;
}): DnsRecord {
  return {
    type: "MX",
    name: input.inboundDomain,
    value: input.inboundEndpoint,
    priority: INBOUND_MX_PRIORITY,
    purpose: "mx",
    status: input.status,
  };
}

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

/**
 * What `enable` has to do to the shared rule set for one recipient.
 *
 *  - `converged` — the domain is already held by a healthy rule of ours. No
 *    write, on an API AWS throttles to one request per second;
 *  - `write` — put this rule with these recipients. Covers all three of
 *    appending to a rule with room, opening the next shard when none has, and
 *    REPAIRING a held rule that is disabled or points at the wrong bucket;
 *  - `foreign` — a rule we did not name holds this recipient. `putRule` is a
 *    REPLACE, so writing it would delete whatever that rule carries.
 */
export type InboundRulePlan =
  | { kind: "converged"; ruleName: string }
  | { kind: "write"; ruleName: string; recipients: string[] }
  | { kind: "foreign"; ruleName: string };

function holdsRecipient(rule: SesInboundRule, recipient: string): boolean {
  return rule.recipients.some((held) => sameHost(held, recipient));
}

/** Does the held rule already say everything we would write? */
function ruleIsHealthy(
  rule: SesInboundRule,
  store: SesInboundStoreAction,
): boolean {
  if (!rule.enabled || !rule.scanEnabled) return false;
  if (rule.actions.length !== 1) return false;
  const [action] = rule.actions;
  return (
    action?.kind === "store" &&
    action.bucketName === store.bucketName &&
    action.topicArn === store.topicArn &&
    action.objectKeyPrefix === store.objectKeyPrefix
  );
}

export function planInboundRule(input: {
  /** The rules currently in the shared set, as READ BACK from SES. */
  rules: SesInboundRule[];
  recipient: string;
  store: SesInboundStoreAction;
}): InboundRulePlan {
  const { rules, recipient, store } = input;

  const foreign = rules.find(
    (rule) =>
      inboundRuleShard(rule.ruleName) === null &&
      holdsRecipient(rule, recipient),
  );
  if (foreign) return { kind: "foreign", ruleName: foreign.ruleName };

  const ours = rules.filter((rule) => inboundRuleShard(rule.ruleName) !== null);

  const holder = ours.find((rule) => holdsRecipient(rule, recipient));
  if (holder) {
    // "Already listed" is NOT "already working": a rule can exist disabled, or
    // with an action pointing at a bucket that no longer receives, and it reads
    // back perfectly while dropping every reply on the floor.
    return ruleIsHealthy(holder, store)
      ? { kind: "converged", ruleName: holder.ruleName }
      : {
          kind: "write",
          ruleName: holder.ruleName,
          recipients: [...holder.recipients],
        };
  }

  const room = ours.find(
    (rule) => rule.recipients.length < SES_INBOUND_MAX_RECIPIENTS_PER_RULE,
  );
  if (room) {
    return {
      kind: "write",
      ruleName: room.ruleName,
      recipients: [...room.recipients, recipient],
    };
  }

  // Every shard is full at AWS's unadjustable 500. Open the next one rather
  // than the 501st rule — the number comes from the highest shard that exists,
  // never from the count, so a hole left by a teardown cannot collide.
  const next =
    ours.reduce(
      (highest, rule) =>
        Math.max(highest, inboundRuleShard(rule.ruleName) ?? 0),
      0,
    ) + 1;
  return {
    kind: "write",
    ruleName: inboundRuleName(next),
    recipients: [recipient],
  };
}

/**
 * One rule to rewrite. `recipients: []` means DELETE the rule — never write it.
 *
 * `ReceiptRule.Recipients`, verbatim: "If this field is not specified, this rule
 * matches all recipients on all verified domains." So an emptied rule is not an
 * inert rule, it is one tenant's action swallowing every other tenant's inbound
 * mail. The seam refuses to write one; this type is why nobody tries.
 */
export interface InboundRemovalStep {
  ruleName: string;
  recipients: string[];
}

export type InboundRemovalPlan =
  | { kind: "steps"; steps: InboundRemovalStep[] }
  | { kind: "foreign"; ruleName: string };

/**
 * What `disable` has to do.
 *
 * `recipients` is PLURAL for two reasons that both really happen: a domain
 * enabled, disabled and re-enabled on a different label can hold two names, and
 * a partial failure or a hand edit can leave the same name in two shards.
 * Removing one and reporting success would leave mail still arriving.
 */
export function planInboundRemoval(input: {
  rules: SesInboundRule[];
  recipients: string[];
}): InboundRemovalPlan {
  const { rules, recipients } = input;
  const holds = (rule: SesInboundRule): boolean =>
    recipients.some((recipient) => holdsRecipient(rule, recipient));

  const foreign = rules.find(
    (rule) => inboundRuleShard(rule.ruleName) === null && holds(rule),
  );
  // Refused rather than ignored: reporting "disabled" while a console-made rule
  // still routes this domain's mail would be a lie an operator acts on.
  if (foreign) return { kind: "foreign", ruleName: foreign.ruleName };

  const steps = rules
    .filter((rule) => inboundRuleShard(rule.ruleName) !== null && holds(rule))
    .map((rule) => ({
      ruleName: rule.ruleName,
      recipients: rule.recipients.filter(
        (held) => !recipients.some((recipient) => sameHost(held, recipient)),
      ),
    }));
  return { kind: "steps", steps };
}

/** Every recipient in the shared set that receives for this domain. */
export function inboundRecipientsFor(
  rules: SesInboundRule[],
  domain: string,
): { ruleName: string; recipient: string }[] {
  const suffix = `.${domain.toLowerCase()}`;
  return rules.flatMap((rule) =>
    rule.recipients
      .filter((recipient) => recipient.toLowerCase().endsWith(suffix))
      .map((recipient) => ({ ruleName: rule.ruleName, recipient })),
  );
}
