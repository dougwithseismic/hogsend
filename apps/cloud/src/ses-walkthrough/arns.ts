import { SesError } from "../ses/types";

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

/** The addr-spec's domain — the identity a `from` address resolves to. */
export function domainOfAddress(address: string): string {
  const angle = /<([^<>]*)>\s*$/.exec(address);
  const addrSpec = (angle?.[1] ?? address).trim().toLowerCase();
  const at = addrSpec.lastIndexOf("@");
  return at >= 0 ? addrSpec.slice(at + 1) : addrSpec;
}
