import { sesConfigurationSetName, sesTenantName } from "../../../src/ses/names";

/**
 * What ONE run of the live walkthrough calls its own AWS resources.
 *
 * Two properties, both load-bearing (PRD 11):
 *
 *  - **Run-scoped.** Every resource carries the run id, so two operators can
 *    run the script at the same time without colliding, and a run that crashed
 *    before teardown leaves resources whose names say exactly which run made
 *    them. A shared fixed name would make a crashed run indistinguishable from
 *    a live one, and the safe response to that ambiguity is to leave BOTH
 *    behind — which is how a "temporary" tenant becomes permanent.
 *  - **Derived through `src/ses/names.ts`, never invented here.** The tenant
 *    and the configuration set are named by the same two functions provisioning
 *    uses, so the walkthrough proves the shape production actually mints rather
 *    than a lookalike. That is why the run id is threaded through as a
 *    SYNTHETIC environment id instead of being pasted into a template string.
 */

/**
 * The synthetic environment id prefix. `sesTenantName` turns it into
 * `env-ses-walkthrough-…`, which is the string a sweep greps for.
 */
export const WALKTHROUGH_ENVIRONMENT_PREFIX = "ses-walkthrough";

/** `env-ses-walkthrough-` — the marker that says "the script made this". */
export const WALKTHROUGH_TENANT_PREFIX = sesTenantName(
  `${WALKTHROUGH_ENVIRONMENT_PREFIX}-`,
);

/** The event destination's name, mirroring `SES_EVENT_DESTINATION_NAME`. */
export const WALKTHROUGH_EVENT_DESTINATION_NAME = "hogsend-events";

/**
 * The default parent of the run-scoped identity.
 *
 * A subdomain of a domain we own, which never has DNS published for it: the
 * identity is created, its DKIM record is READ BACK from AWS and compared, and
 * it is deleted minutes later. It can therefore never verify and can never
 * send, which is exactly what we want from a contract probe. `--identity-base`
 * overrides it, `--identity-domain` replaces it outright.
 */
export const DEFAULT_IDENTITY_BASE = "ses-walkthrough.hogsend.com";

export interface WalkthroughNames {
  runId: string;
  /** The synthetic environment id the two SES names are derived from. */
  environmentId: string;
  tenantName: string;
  configurationSetName: string;
  eventDestinationName: string;
  identityDomain: string;
  /** `send.<identityDomain>` — the branded return path PRD 07 offers. */
  mailFromDomain: string;
}

/**
 * `<yyyymmdd>-<hhmmss>-<entropy>`, in UTC.
 *
 * Takes its clock and its entropy as ARGUMENTS so the naming is a pure function
 * a test can pin — the same reason `FakeSesClient` has no `Date.now()`. The
 * caller (the script) supplies the real ones.
 */
export function walkthroughRunId(now: Date, entropy: string): string {
  const iso = now.toISOString();
  const day = iso.slice(0, 10).replace(/-/g, "");
  const time = iso.slice(11, 19).replace(/:/g, "");
  return `${day}-${time}-${entropy}`;
}

export function walkthroughNames(input: {
  runId: string;
  identityBase: string;
  /** An explicit domain, used verbatim, for an operator who owns one. */
  identityDomain?: string;
}): WalkthroughNames {
  const environmentId = `${WALKTHROUGH_ENVIRONMENT_PREFIX}-${input.runId}`;
  return {
    runId: input.runId,
    environmentId,
    tenantName: sesTenantName(environmentId),
    configurationSetName: sesConfigurationSetName(environmentId),
    eventDestinationName: WALKTHROUGH_EVENT_DESTINATION_NAME,
    identityDomain:
      input.identityDomain ?? `${input.runId}.${input.identityBase}`,
    mailFromDomain: `send.${
      input.identityDomain ?? `${input.runId}.${input.identityBase}`
    }`,
  };
}

/** Did the script mint this tenant? The whole account-safety guard rests here. */
export function isWalkthroughTenantName(tenantName: string): boolean {
  return tenantName.startsWith(WALKTHROUGH_TENANT_PREFIX);
}
