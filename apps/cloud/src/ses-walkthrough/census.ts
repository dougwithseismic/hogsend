import { paginateListTenants, SESv2Client } from "@aws-sdk/client-sesv2";
import type { AwsSesCredentials } from "../ses/aws";
import type { SesRegion } from "../ses/types";

/**
 * "What tenants does this account already hold?"
 *
 * ## Why this is not on the SES seam, and what is owed
 *
 * `SesClient` has NINETEEN verbs and `listTenants` is not one of them, because
 * nothing in the control plane needs it: production addresses exactly one
 * tenant per environment, by a name it derives itself. The walkthrough is the
 * first caller that needs to enumerate, and it needs it for a safety guard
 * rather than for a feature.
 *
 * Adding a twentieth verb is a PRD 02 decision, not this PRD's, so this is the
 * ONE AWS call in the whole script that does not go through
 * `getSesClient(region)`. It is deliberately the narrowest thing that can
 * answer the question:
 *
 *  - **read-only.** `ListTenants` and nothing else;
 *  - **same credentials, no new configuration.** It takes the pair the
 *    credential guard already validated — there is still exactly one way to
 *    authenticate to SES in this repository;
 *  - **isolated here**, so promoting it to a real seam verb later is a delete
 *    of this file and a call-site change, not an archaeology exercise.
 *
 * The alternative was worse in a way this repo has already been burned by: a
 * guard with nothing behind it. Without an enumeration the account-not-empty
 * refusal could only be an operator's assertion on the command line, which
 * reads as a safety check and checks nothing — and the failure it is supposed
 * to prevent is "the destructive walkthrough ran against the account holding
 * live customers".
 *
 * Recorded as an OPEN ITEM: `listTenants` wants to be verb #20.
 */

/** Every tenant name in the account. */
export type TenantCensus = () => Promise<string[]>;

export interface AwsTenantCensusOptions {
  awsRegion: SesRegion;
  credentials: AwsSesCredentials;
  /** Overrides the SDK's retry budget. Read-only call; three is plenty. */
  maxAttempts?: number;
}

export function awsTenantCensus(options: AwsTenantCensusOptions): TenantCensus {
  return async () => {
    const client = new SESv2Client({
      region: options.awsRegion,
      maxAttempts: options.maxAttempts ?? 3,
      credentials: options.credentials,
    });
    try {
      const names: string[] = [];
      // Paginated: an account at the tenant limit would otherwise answer one
      // page and the guard would clear an account it never finished reading.
      for await (const page of paginateListTenants({ client }, {})) {
        for (const tenant of page.Tenants ?? []) {
          if (tenant.TenantName) names.push(tenant.TenantName);
        }
      }
      return names;
    } finally {
      client.destroy();
    }
  };
}
