import { sesConfigurationSetName, sesTenantName } from "../ses/names";
import {
  WALKTHROUGH_ENVIRONMENT_PREFIX,
  WALKTHROUGH_EVENT_DESTINATION_NAME,
} from "../ses-walkthrough/naming";

/**
 * What ONE run of the delivery proof calls its own resources — AWS resources
 * AND control-plane rows, because this script (unlike the walkthrough) also
 * registers a run-scoped stack so the signed instance hop has somewhere real
 * to land.
 *
 * The environment id extends the WALKTHROUGH prefix rather than minting a new
 * family: `env-ses-walkthrough-proof-<runId>` still starts with
 * `env-ses-walkthrough-`, so `isWalkthroughTenantName` recognises it and the
 * existing account-sweep guard treats a crashed proof run as sweepable residue
 * instead of refusing every future run. A second prefix would need a second
 * sweeper, and a tenant only one of two sweepers recognises is a tenant that
 * leaks.
 */

export const PROOF_ENVIRONMENT_PREFIX = `${WALKTHROUGH_ENVIRONMENT_PREFIX}-proof`;

export interface ProofNames {
  runId: string;
  /** The synthetic environment id the SES names are derived from. */
  environmentId: string;
  tenantName: string;
  configurationSetName: string;
  eventDestinationName: string;
  /**
   * The run-scoped control-plane organization row (text primary key). Every
   * database row this run registers hangs off it, so teardown is ONE delete
   * and the cascades do the rest.
   */
  organizationId: string;
}

export function proofNames(runId: string): ProofNames {
  const environmentId = `${PROOF_ENVIRONMENT_PREFIX}-${runId}`;
  return {
    runId,
    environmentId,
    // Derived through `src/ses/names.ts`, never invented here — the same rule
    // the walkthrough holds: the proof must exercise the shape production
    // actually mints.
    tenantName: sesTenantName(environmentId),
    configurationSetName: sesConfigurationSetName(environmentId),
    eventDestinationName: WALKTHROUGH_EVENT_DESTINATION_NAME,
    organizationId: environmentId,
  };
}
