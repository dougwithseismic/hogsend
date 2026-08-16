import { SesError } from "../../../src/ses/types";

/**
 * ARNs for the resources a tenant is associated with, derived from the TENANT's
 * own ARN.
 *
 * The account id and partition are read off an ARN AWS handed us rather than
 * assembled from configuration, because nothing in the control plane is ever
 * told which account its credentials belong to — and an ARN built around a
 * guessed account id fails as `not_found` at association time, which reads like
 * a missing resource rather than like the misconfiguration it is.
 *
 * The same derivation exists privately inside `services/ses-tenants.ts` and
 * `services/ses-domains.ts`. It is repeated here rather than exported from
 * either, because those modules reach the database and this script must not:
 * the walkthrough runs against an AWS account with no Cloud environment behind
 * it. If the derivation ever changes, the walkthrough is the thing that reports
 * the mismatch — it associates and then sends, and a wrong ARN makes the send
 * fail.
 */

export function tenantScopedArn(
  tenantArn: string,
  resourceType: "configuration-set" | "identity",
  resourceName: string,
): string {
  const [prefix, partition, service, region, account] = tenantArn.split(":");
  if (prefix !== "arn" || !partition || !service || !region || !account) {
    throw new SesError(
      `cannot derive a ${resourceType} ARN: tenant ARN ${JSON.stringify(
        tenantArn,
      )} is not an ARN`,
      { kind: "invalid" },
    );
  }
  return `arn:${partition}:${service}:${region}:${account}:${resourceType}/${resourceName}`;
}

/**
 * The lowercased addr-spec out of an RFC 5322 `from` — `"Acme <a@b.c>"` or
 * bare `a@b.c`. Both forms name the same mailbox, so both must reduce to it.
 */
function addrSpecOf(address: string): string {
  const angle = /<([^<>]*)>\s*$/.exec(address);
  return (angle?.[1] ?? address).trim().toLowerCase();
}

/** The addr-spec's parent domain. */
export function domainOfAddress(address: string): string {
  const addrSpec = addrSpecOf(address);
  const at = addrSpec.lastIndexOf("@");
  return at >= 0 ? addrSpec.slice(at + 1) : addrSpec;
}

/**
 * SES's two identity types, which is what decides an identity's ARN.
 *
 * `MANAGED_DOMAIN` is deliberately absent: it is a domain AWS manages on the
 * sender's behalf, nothing here creates one, and naming a case we have never
 * exercised would imply coverage that does not exist.
 */
export type SesIdentityType = "EMAIL_ADDRESS" | "DOMAIN";

export interface SenderIdentityCandidate {
  type: SesIdentityType;
  /** The identity's NAME — exactly what an `identity/<name>` ARN carries. */
  name: string;
}

/**
 * The identities a `from` address may resolve to, in SES's OWN order.
 *
 * An address is held by SES either as an EMAIL_ADDRESS identity of its own or
 * under its parent DOMAIN identity, and the two produce DIFFERENT ARNs. Which
 * one applies is a property of the ACCOUNT rather than of the address, so this
 * returns both candidates in preference order and leaves the choice to whoever
 * can ask: the address first, then the domain — the same order
 * `FakeSesClient.deliver` and the delivery proof both resolve a sender in.
 *
 * This exists because the second live walkthrough (2026-08-11) took the parent
 * domain UNCONDITIONALLY: `ses-proof@hogsend.com` became `identity/hogsend.com`,
 * which the account does not hold at all, and AWS answered "Identity
 * <hogsend.com> does not exist". A bare domain has one candidate, not two — it
 * is already an identity name, and offering it twice would read as a choice.
 */
export function senderIdentityCandidates(
  address: string,
): SenderIdentityCandidate[] {
  const addrSpec = addrSpecOf(address);
  const domain = domainOfAddress(address);
  return addrSpec === domain
    ? [{ type: "DOMAIN", name: domain }]
    : [
        { type: "EMAIL_ADDRESS", name: addrSpec },
        { type: "DOMAIN", name: domain },
      ];
}
