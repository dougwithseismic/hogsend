import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { env } from "../env";
import type { InboundStore, MxLookup, MxRecord } from "../lib/inbound-domains";
import {
  foreignMxExchanges,
  INBOUND_RULE_SET_NAME,
  INBOUND_SUBDOMAIN,
  inboundDomainFor,
  inboundMxIsPublished,
  inboundMxOverridePhrase,
  inboundMxRecord,
  inboundRecipientsFor,
  inboundStoreAction,
  planInboundRemoval,
  planInboundRule,
  resolveInboundMx,
  resolveInboundStore,
} from "../lib/inbound-domains";
import type {
  DnsRecord,
  DnsRecordStatus,
  DomainStatus,
} from "../lib/sending-domains";
import { HOGSEND_PROVIDER_ID, normalizeDomain } from "../lib/sending-domains";
import type { SesInboundClient } from "../ses/inbound/contract";
import { getSesInboundClient } from "../ses/inbound/index";
import type {
  SesInboundRule,
  SesInboundStoreAction,
} from "../ses/inbound/types";
import { SesError } from "../ses/types";
import type { SubstrateRegion } from "../substrate/types";
import { writeAudit } from "./audit";
import { CloudServiceError } from "./errors";
import type { Tenancy } from "./ses-domains";
import {
  InvalidDomainError,
  loadTenancy,
  requireDomainOwnership,
} from "./ses-domains";
import {
  deleteInboundConfig,
  readInboundConfig,
  writeInboundConfig,
} from "./ses-inbound-config";

/**
 * Inbound receiving, per domain (PRD 16 task 3) — the receiving twin of
 * `ses-domains.ts`, and deliberately its mirror in shape: `enable` / `disable` /
 * `get` / `records`, one neutral `DomainStatus` out, nothing thrown for a domain
 * nobody has enabled.
 *
 * Four decisions carry this file, and every one of them is here because getting
 * it wrong is silent:
 *
 *  - **The apex is never the target, and that is structural.** A customer's
 *    apex MX is their real company mailbox; repointing it at SES does not add
 *    replies, it DELETES their company email. The record this emits is always
 *    `reply.<domain>` because `inboundDomainFor` cannot produce anything else,
 *    and the DNS guard below refuses even that name when somebody ELSE's mail
 *    already arrives there — unless an operator types the confirmation phrase
 *    naming that exact domain. The apex itself is deliberately NOT looked up:
 *    it is expected to have an MX (that is the point), it is none of our
 *    business, and refusing on it would refuse every real customer.
 *  - **One shared active rule set, adopted or refused — never displaced.**
 *    Activating a rule set silently deactivates whatever was active, account
 *    wide, for every tenant in the region at once. So provisioning READS
 *    `getActiveRuleSet` before it writes anything: ours, adopt; nothing,
 *    activate; somebody else's, refuse. There is no override for that one,
 *    because the blast radius is every other customer in the region.
 *  - **Domains are PACKED into few rules.** A rule matches domains, 500 of them,
 *    and every tenant shares one action — so a rule per tenant would hit the
 *    unadjustable 200-rule ceiling at the 201st customer and buy nothing. See
 *    `lib/inbound-domains.ts` for the arithmetic.
 *  - **Forwarding is mandatory, so it is settled BEFORE anything is written.**
 *    A rule that receives mail for a domain with no forwarding address on file
 *    swallows a human's reply, and PRD 16 calls that a broken business rather
 *    than a missing feature. The address is validated first and stored second,
 *    and only then does the first SES write happen — a stored address with no
 *    rule is inert, while a rule with no stored address is the failure.
 *
 * Every step is idempotent and CONVERGES on a re-drive. PRD 22 exists because
 * the sending-domain flow had an early return sitting above a required side
 * effect, so there is no early return here: `enable` re-asserts the rule set,
 * the active pointer, the rule's contents and the stored address on every call,
 * and only skips the WRITE when a read has already proved it unnecessary.
 */

/** The capability. `DomainStatus` and `DnsRecord` are the sending-domain shapes. */
export interface HogsendInbound {
  /** Turn replies on for a domain. Idempotent; re-drives converge. */
  enable(input: EnableInboundInput): Promise<DomainStatus>;
  /** Turn replies off. Removes only this domain, and never empties a rule. */
  disable(domain: string): Promise<DomainStatus>;
  /** Current state, or `null` when this domain is not receiving. */
  get(domain: string): Promise<DomainStatus | null>;
  /** The DNS record the customer must publish. `[]` when not enabled. */
  records(domain: string): Promise<DnsRecord[]>;
}

export interface EnableInboundInput {
  domain: string;
  /**
   * The human mailbox every received reply is forwarded to.
   *
   * Optional ONLY because a re-drive may rely on the address a previous enable
   * stored. With neither, this call is refused — see
   * {@link MissingForwardAddressError}.
   */
  forwardTo?: string;
  /** The subdomain replies arrive on. Defaults to `reply`. */
  label?: string;
  /**
   * The typed confirmation from {@link inboundMxOverridePhrase}, and the ONLY
   * way past an MX we did not create. It names the domain, so it cannot be
   * pasted from the confirmation written for a different one.
   */
  confirmMxReplacement?: string;
}

export interface SesInboundDeps {
  db?: CloudDb;
  /** Defaults to the process-wide client for the tenancy's pinned region. */
  inbound?: SesInboundClient;
  /**
   * The region's bucket + topic. `null` means inbound is not configured here,
   * which is a MODE; `undefined` reads the environment.
   */
  store?: InboundStore | null;
  /** The DNS seam. Tests inject; nothing in CI resolves a real name. */
  lookupMx?: MxLookup;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/** This region has no inbound bucket and topic, so inbound cannot be turned on. */
export class InboundNotConfiguredError extends CloudServiceError {
  readonly code = "inbound_not_configured";

  constructor(readonly region: SubstrateRegion) {
    super(
      `Inbound receiving is not configured for region "${region}". Set ` +
        "CLOUD_SES_INBOUND_BUCKET and the region's CLOUD_SES_INBOUND_TOPIC_ARN_* " +
        "before enabling replies: a receipt rule with no bucket to store into " +
        "and no topic to notify would accept a customer's reply and tell nobody.",
    );
  }
}

/**
 * Enabling inbound with nowhere to forward to. EARS, verbatim: "WHEN inbound is
 * enabled without a forwarding address configured, the system SHALL refuse to
 * enable it, because that configuration silently swallows a customer's replies."
 */
export class MissingForwardAddressError extends CloudServiceError {
  readonly code = "inbound_forward_address_required";

  constructor(readonly domain: string) {
    super(
      `Enabling inbound replies for "${domain}" needs a forwarding address ` +
        "(forwardTo), and it must be a single mailbox like " +
        '"support@acme.com". A person replying to your email expects a human ' +
        "to read it, so Hogsend forwards every received message before it emits " +
        "an event. With nowhere to forward to, turning inbound on would " +
        "silently swallow their reply.",
    );
  }
}

/** Somebody else's mail already arrives at the name we would publish. */
export class ForeignInboundMxError extends CloudServiceError {
  readonly code = "inbound_mx_conflict";

  constructor(
    readonly inboundDomain: string,
    readonly exchanges: string[],
  ) {
    super(
      `"${inboundDomain}" already has MX records Hogsend did not create ` +
        `(${exchanges.join(", ")}). Publishing ours would take that mail away ` +
        "from whoever receives it today. If that is genuinely what you want, " +
        `retry with confirmMxReplacement: "${inboundMxOverridePhrase(
          inboundDomain,
        )}".`,
    );
  }
}

/** DNS could not answer, and "we do not know" is not "there is nothing there". */
export class InboundMxLookupError extends CloudServiceError {
  readonly code = "inbound_mx_lookup_failed";

  constructor(
    readonly inboundDomain: string,
    readonly cause: unknown,
  ) {
    super(
      `Could not read the MX records at "${inboundDomain}" (${
        cause instanceof Error ? cause.message : String(cause)
      }), so Hogsend cannot tell whether publishing ours would displace mail ` +
        "that already arrives there. Retry, or override with " +
        `confirmMxReplacement: "${inboundMxOverridePhrase(inboundDomain)}".`,
    );
  }
}

/**
 * A rule set we do not own is receiving for this account and region.
 *
 * No override. Activating ours would deactivate theirs account-wide and stop
 * every other tenant in the region at once, and there is no confirmation phrase
 * that makes that a supported operation.
 */
export class ForeignInboundRuleSetError extends CloudServiceError {
  readonly code = "inbound_rule_set_conflict";

  constructor(readonly activeRuleSetName: string) {
    super(
      `Receipt rule set "${activeRuleSetName}" is active for this AWS account ` +
        `and region, and Hogsend will not displace it. Only one rule set can be ` +
        `active at a time, so activating "${INBOUND_RULE_SET_NAME}" would stop ` +
        "email receiving for everything that set serves. Migrate its rules into " +
        `"${INBOUND_RULE_SET_NAME}" (or delete it) and retry.`,
    );
  }
}

/** A rule we did not name holds this domain, and `putRule` is a REPLACE. */
export class ForeignInboundRuleError extends CloudServiceError {
  readonly code = "inbound_rule_conflict";

  constructor(
    readonly ruleName: string,
    readonly inboundDomain: string,
  ) {
    super(
      `Receipt rule "${ruleName}" already receives for "${inboundDomain}" and ` +
        "Hogsend did not create it. Writing that rule would replace it whole, " +
        "including any action it carries, so this needs a human: remove the " +
        "domain from that rule and retry.",
    );
  }
}

/** The domain already receives on a different label. */
export class InboundLabelConflictError extends CloudServiceError {
  readonly code = "inbound_label_conflict";

  constructor(
    readonly domain: string,
    readonly current: string,
    readonly requested: string,
  ) {
    super(
      `"${domain}" already receives replies on "${current}.${domain}". ` +
        `Switching to "${requested}.${domain}" would leave both names ` +
        "receiving, one of them forgotten. Disable inbound for the domain " +
        "first, then enable it on the new label.",
    );
  }
}

// ---------------------------------------------------------------------------
// The capability
// ---------------------------------------------------------------------------

/**
 * A single mailbox address, and nothing that could be a header.
 *
 * The domain half is the pinned `sending-domains` shape; the local half refuses
 * whitespace, commas, semicolons and angle brackets. That is not pedantry: this
 * string is written into the `To:` of a message we forward, so a value carrying
 * a comma or a newline is a header-injection surface, and one carrying a display
 * name is an address we would fail to parse at forwarding time — after we had
 * already promised to deliver it.
 */
const FORWARD_ADDRESS_RE =
  /^[^\s@,;<>"]+@([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

export function createHogsendInbound(
  input: { environmentId: string; actor?: string },
  deps: SesInboundDeps = {},
): HogsendInbound {
  const db = deps.db ?? defaultDb;
  const { environmentId } = input;
  const now = deps.now ?? (() => new Date());
  const lookupMx = deps.lookupMx ?? resolveInboundMx;

  /** Resolved once per instance — every method needs the same region. */
  let cached: Promise<Tenancy> | undefined;
  const tenancy = (): Promise<Tenancy> => {
    cached ??= loadTenancy(db, environmentId);
    return cached;
  };

  const client = async (): Promise<SesInboundClient> => {
    if (deps.inbound) return deps.inbound;
    // The region the tenant was minted IN. Receipt rule sets are region-scoped
    // and the active one is a per-region account-wide switch, so addressing
    // the wrong region would arm — or disarm — receiving where nobody looks.
    return getSesInboundClient((await tenancy()).region);
  };

  const store = async (): Promise<SesInboundStoreAction> => {
    const region = (await tenancy()).region;
    const resolved =
      deps.store === undefined ? resolveInboundStore(env, region) : deps.store;
    if (!resolved) throw new InboundNotConfiguredError(region);
    return inboundStoreAction(resolved);
  };

  /**
   * The shared set's rules, or `null` when the set does not exist yet.
   *
   * `null` is how "never provisioned" is told apart from "provisioned and
   * empty", and the two need different next steps.
   */
  const readRules = async (
    ses: SesInboundClient,
  ): Promise<SesInboundRule[] | null> => {
    try {
      return (await ses.getRuleSet({ ruleSetName: INBOUND_RULE_SET_NAME }))
        .rules;
    } catch (error) {
      if (error instanceof SesError && error.kind === "not_found") return null;
      throw error;
    }
  };

  const snapshot = async (
    domain: string,
    rules: SesInboundRule[] | null,
    published?: boolean,
  ): Promise<DomainStatus | null> => {
    const ses = await client();
    const holders = inboundRecipientsFor(rules ?? [], domain);
    const holder = holders[0];
    if (!holder) return null;

    const rule = (rules ?? []).find(
      (held) => held.ruleName === holder.ruleName,
    );
    const config = await readInboundConfig({ environmentId, domain }, { db });
    return {
      domain,
      // A rule that exists and cannot deliver is FAILED, not pending. It reads
      // back perfectly and drops every reply on the floor, which is the one
      // outcome a status must never render as healthy.
      state:
        !rule || !ruleReceives(rule)
          ? "failed"
          : published
            ? "verified"
            : "pending",
      records: [
        inboundMxRecord({
          inboundDomain: holder.recipient,
          inboundEndpoint: ses.inboundEndpoint,
          status: recordStatus(published),
        }),
      ],
      providerId: HOGSEND_PROVIDER_ID,
      checkedAt: now().toISOString(),
      raw: {
        ruleSetName: INBOUND_RULE_SET_NAME,
        ruleName: holder.ruleName,
        recipient: holder.recipient,
        forwardTo: config?.forwardTo ?? null,
      },
    };
  };

  /** EARS 8's answer for a domain that is not receiving: a status, not a throw. */
  const absent = (domain: string): DomainStatus => ({
    domain,
    state: "not_found",
    records: [],
    providerId: HOGSEND_PROVIDER_ID,
    checkedAt: now().toISOString(),
  });

  const get = async (domain: string): Promise<DomainStatus | null> => {
    const name = requireDomain(domain);
    const ses = await client();
    // NO DNS lookup here. `get` is a read a dashboard may poll, the guard's
    // lookup is a gate on a rare operator action, and paying for a resolution
    // on every poll to learn something only the customer's DNS host can change
    // would be the wrong trade. The record comes back `unknown`, which is the
    // honest word for "we did not check".
    return snapshot(name, await readRules(ses));
  };

  return {
    async enable(request: EnableInboundInput): Promise<DomainStatus> {
      const domain = requireDomain(request.domain);
      const tenant = await tenancy();
      const ses = await client();
      // (0) OWNERSHIP, before every other check, because it is the cheapest and
      // the most consequential. Receiving is enabled on a domain by writing
      // into the account-wide active rule set and storing a forwarding address
      // for it; done for a domain this environment never added, that is one
      // tenant reading — and forwarding to a mailbox of its choosing — another
      // tenant's replies. The deed is the sending domain's stored DKIM key,
      // exactly as on the sending side (see `DomainNotOwnedError`).
      //
      // `enable` has no production caller today. The guard is here so that
      // giving it one cannot open this door by accident.
      await requireDomainOwnership({ db, environmentId, domain });
      // Before ANY write, and before the DNS round trip: a region with no
      // bucket and no topic cannot receive at all, so there is nothing to ask
      // DNS about.
      const action = await store();

      const stored = await readInboundConfig({ environmentId, domain }, { db });
      if (stored && request.label && stored.label !== request.label) {
        throw new InboundLabelConflictError(
          domain,
          stored.label,
          request.label,
        );
      }
      const label = request.label ?? stored?.label ?? INBOUND_SUBDOMAIN;
      const inboundDomain = inboundDomainFor(domain, label);

      // (1) Forwarding, first. Refused here, nothing else has happened yet.
      const forwardTo = requireForwardAddress(
        domain,
        request.forwardTo ?? stored?.forwardTo,
      );

      // (2) The MX guard, still before any write.
      const mx = await readMx(lookupMx, inboundDomain);
      const displaced = foreignMxExchanges(mx, ses.inboundEndpoint);
      const overridden =
        displaced.length > 0 &&
        request.confirmMxReplacement?.trim() ===
          inboundMxOverridePhrase(inboundDomain);
      if (displaced.length > 0 && !overridden) {
        throw new ForeignInboundMxError(inboundDomain, displaced);
      }

      // (3) READ the account-wide switch before touching it. Adopt ours, refuse
      // somebody else's, and activate only when nothing is receiving.
      const active = await ses.getActiveRuleSet();
      const adopted = active.ruleSetName === INBOUND_RULE_SET_NAME;
      if (active.ruleSetName !== undefined && !adopted) {
        throw new ForeignInboundRuleSetError(active.ruleSetName);
      }

      // (4) The address is durable BEFORE the rule that starts delivering mail
      // to it. The other order leaves SES receiving replies the control plane
      // has nowhere to forward — the exact state this feature refuses to make.
      await writeInboundConfig(
        { environmentId, domain, config: { forwardTo, label } },
        { db },
      );

      // (5) The shared set. When ours is already active its rules came back
      // with the active read, so a converged re-drive costs no extra call.
      let rules = adopted ? active.rules : await readRules(ses);
      if (rules === null) {
        await tolerateExists(() =>
          ses.createRuleSet({ ruleSetName: INBOUND_RULE_SET_NAME }),
        );
        rules = [];
      }

      // (6) Pack.
      const plan = planInboundRule({
        rules,
        recipient: inboundDomain,
        store: action,
      });
      if (plan.kind === "foreign") {
        throw new ForeignInboundRuleError(plan.ruleName, inboundDomain);
      }
      if (plan.kind === "write") {
        await ses.putRule({
          ruleSetName: INBOUND_RULE_SET_NAME,
          ruleName: plan.ruleName,
          recipients: plan.recipients,
          store: action,
          // Sent explicitly, never left to AWS: `Enabled` defaults to FALSE at
          // AWS, and a rule created disabled exists, reads back cleanly and
          // receives nothing.
          enabled: true,
          scanEnabled: true,
        });
      }

      // (7) Activate LAST, and only when nothing was active — by now the rule
      // is already in place, so the set never goes live empty.
      if (!adopted) {
        await ses.setActiveRuleSet({ ruleSetName: INBOUND_RULE_SET_NAME });
      }

      await writeAudit(db, {
        actor: input.actor ?? "system",
        organizationId: tenant.organizationId,
        action: "email_inbound.enabled",
        subject: domain,
        detail: {
          environmentId,
          domain,
          inboundDomain,
          ruleSetName: INBOUND_RULE_SET_NAME,
          ruleName: plan.ruleName,
          forwardTo,
          // An operator publishing over somebody else's MX is the single most
          // consequential thing this service can be asked to do. It is never
          // silent.
          ...(overridden ? { mxOverride: true, displacedMx: displaced } : {}),
        },
      });

      // Re-READ rather than assume, the same call `setReturnPath` makes: the
      // answer describes what SES holds now, so a write that silently did
      // nothing cannot be reported as a success.
      const after = await readRules(ses);
      return (
        (await snapshot(
          domain,
          after,
          inboundMxIsPublished(mx, ses.inboundEndpoint),
        )) ?? absent(domain)
      );
    },

    async disable(domain: string): Promise<DomainStatus> {
      const name = requireDomain(domain);
      const tenant = await tenancy();
      const ses = await client();
      const rules = await readRules(ses);

      // Every name under this domain, whatever label it was enabled on — a
      // teardown that only looked for `reply.` would leave a renamed one live.
      const recipients = [
        ...new Set(
          inboundRecipientsFor(rules ?? [], name).map((h) => h.recipient),
        ),
      ];
      const plan = planInboundRemoval({ rules: rules ?? [], recipients });
      if (plan.kind === "foreign") {
        throw new ForeignInboundRuleError(plan.ruleName, name);
      }

      for (const step of plan.steps) {
        if (step.recipients.length === 0) {
          // DELETED, never written empty: SES reads an empty recipient list as
          // "every recipient on every verified domain", so an emptied rule
          // would route every OTHER tenant's inbound mail into this action.
          await ses.deleteRule({
            ruleSetName: INBOUND_RULE_SET_NAME,
            ruleName: step.ruleName,
          });
          continue;
        }
        const held = (rules ?? []).find(
          (rule) => rule.ruleName === step.ruleName,
        );
        await ses.putRule({
          ruleSetName: INBOUND_RULE_SET_NAME,
          ruleName: step.ruleName,
          recipients: step.recipients,
          // The rule's OWN action and flags, re-asserted verbatim. A shrink
          // changes exactly one thing — the recipient list — so it must not
          // re-point a rule at today's configuration or silently enable one an
          // operator turned off.
          store: heldStoreAction(held) ?? (await store()),
          enabled: held?.enabled ?? true,
          scanEnabled: held?.scanEnabled ?? true,
          ...(held?.tlsPolicy ? { tlsPolicy: held.tlsPolicy } : {}),
        });
      }

      // The rule SET stays, and stays active, even with no rules left in it.
      // Deactivating it is an account-wide switch, and an empty active set
      // simply matches nothing — which is what "disabled" means here.
      await deleteInboundConfig({ environmentId, domain: name }, { db });

      await writeAudit(db, {
        actor: input.actor ?? "system",
        organizationId: tenant.organizationId,
        action: "email_inbound.disabled",
        subject: name,
        detail: {
          environmentId,
          domain: name,
          ruleSetName: INBOUND_RULE_SET_NAME,
          removed: recipients,
        },
      });

      return absent(name);
    },

    get,

    async records(domain: string): Promise<DnsRecord[]> {
      return (await get(domain))?.records ?? [];
    },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function requireDomain(domain: string): string {
  const name = normalizeDomain(domain);
  if (!name) throw new InvalidDomainError(domain);
  return name;
}

function requireForwardAddress(
  domain: string,
  candidate: string | undefined,
): string {
  const address = candidate?.trim() ?? "";
  if (!FORWARD_ADDRESS_RE.test(address)) {
    throw new MissingForwardAddressError(domain);
  }
  return address;
}

/**
 * Read the MX records, failing CLOSED on anything that is not a definitive
 * answer.
 *
 * The resolver already reports "no such name" and "no MX here" as an empty
 * list, so what reaches this catch is SERVFAIL, a timeout, a refused query —
 * "we could not check". The cost of guessing wrong is a customer's deleted
 * mailbox, so it is a refusal that names the override, not an assumption.
 */
async function readMx(
  lookupMx: MxLookup,
  inboundDomain: string,
): Promise<MxRecord[]> {
  try {
    return await lookupMx(inboundDomain);
  } catch (error) {
    throw new InboundMxLookupError(inboundDomain, error);
  }
}

/** Can this rule actually deliver a reply to us? */
function ruleReceives(rule: SesInboundRule): boolean {
  return (
    rule.enabled &&
    rule.actions.some(
      (action) => action.kind === "store" && Boolean(action.topicArn),
    )
  );
}

/**
 * The store action a rule already carries, or `undefined`.
 *
 * Only a COMPLETE one counts: an S3 action with no topic stores the message and
 * tells nobody, and re-asserting that on a shrink would preserve a rule that
 * looks fine and delivers no event. The seam refuses to write one anyway.
 */
function heldStoreAction(
  rule: SesInboundRule | undefined,
): SesInboundStoreAction | undefined {
  for (const action of rule?.actions ?? []) {
    if (action.kind !== "store" || !action.topicArn) continue;
    const { kind: _kind, ...store } = action;
    return store;
  }
  return undefined;
}

function recordStatus(published: boolean | undefined): DnsRecordStatus {
  if (published === undefined) return "unknown";
  return published ? "verified" : "pending";
}

/**
 * `createRuleSet` is deliberately NOT idempotent on the seam — an existing set
 * may be somebody else's. Here it is a race with our own concurrent enable, and
 * the very next read settles which.
 */
async function tolerateExists(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof SesError && error.kind === "already_exists") return;
    throw error;
  }
}
