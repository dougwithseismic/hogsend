import type { SubstrateRegion } from "../substrate/types";
import {
  SES_REGION_BY_SUBSTRATE_REGION,
  type SesAccount,
  type SesConfigurationSetRef,
  type SesCreateConfigurationSetInput,
  type SesCreateIdentityInput,
  type SesCreateTenantInput,
  SesError,
  type SesIdentity,
  type SesIdentityRef,
  type SesListRecommendationsInput,
  type SesPutEventDestinationInput,
  type SesPutSuppressionScopeInput,
  type SesRecommendationsPage,
  type SesRegion,
  type SesReputationEntity,
  type SesReputationEntityRef,
  type SesResourceAssociationInput,
  type SesSendBatchInput,
  type SesSendBatchResult,
  type SesSendEmailInput,
  type SesSendEmailResult,
  type SesSetMailFromInput,
  type SesSetReputationPolicyInput,
  type SesSetTenantSendingStatusInput,
  type SesTenant,
  type SesTenantRef,
} from "./types";

/**
 * The frozen SES seam: TWENTY verbs, two implementations (`FakeSesClient`,
 * `AwsSesClient`).
 *
 * A later PRD that needs a twenty-first adds it HERE first, in both
 * implementations and in `SES_VERBS` — that is the entire point of having a
 * seam rather than letting each PRD bolt one AWS call onto whatever it is
 * doing.
 *
 * The IAM policy lives in `docs/ses-production-access-request.md` and is NOT
 * restated here, so the two cannot drift. Two things about it are not
 * derivable from this file by reading verb names, so they are recorded where
 * they are decided instead:
 *  - `putEventDestination` is the one verb that is not one AWS operation, so
 *    it needs BOTH `ses:CreateConfigurationSetEventDestination` and
 *    `ses:UpdateConfigurationSetEventDestination` (see below);
 *  - `ses:SendBulkEmail` is deliberately ABSENT — `sendBatch` fans out
 *    `SendEmail`, for the reason given on `AwsSesClient.sendBatch`.
 */
export interface SesClient {
  /** `"aws"` | `"fake"` — which implementation answered. */
  readonly id: string;
  /** The jurisdiction the caller asked for. */
  readonly region: SubstrateRegion;
  /** The AWS region it resolves to. Pinned for the tenant's whole life. */
  readonly awsRegion: SesRegion;

  // -- Send (PRD 03) --------------------------------------------------------

  sendEmail(input: SesSendEmailInput): Promise<SesSendEmailResult>;
  /**
   * Send many messages on one tenant. Returns one result per input message, in
   * order, with per-entry failures rather than an all-or-nothing throw.
   */
  sendBatch(input: SesSendBatchInput): Promise<SesSendBatchResult>;

  // -- Tenant (PRD 06) ------------------------------------------------------

  /**
   * IDEMPOTENT by tenant name: an existing tenant is RETURNED, not an error.
   * Provisioning re-runs its steps after a transient failure, and a resumed
   * provision that threw on its own previous success would be unable to
   * finish.
   *
   * It is the only `create*` verb with that behaviour — every other one
   * mirrors AWS and reports `already_exists`, because for those the caller
   * genuinely wants to know.
   */
  createTenant(input: SesCreateTenantInput): Promise<SesTenant>;
  /**
   * The read-back the rest of the tenant surface is built on: `CreateTenant`
   * returns the ARN only on the call that actually CREATES the tenant, so
   * `createTenant`'s idempotency and both reputation writes (which address a
   * tenant by ARN, never by name) are unimplementable without it.
   */
  getTenant(input: SesTenantRef): Promise<SesTenant>;
  /** Throws `not_found` if the tenant is already gone; a teardown treats that
   * as "already done" by branching on `kind`. */
  deleteTenant(input: SesTenantRef): Promise<void>;
  /** Set membership: re-asserting an existing association is a no-op. */
  associateResource(input: SesResourceAssociationInput): Promise<void>;
  disassociateResource(input: SesResourceAssociationInput): Promise<void>;
  /** A TENANT operation, not a configuration-set one — see
   * {@link SesPutSuppressionScopeInput}. */
  putSuppressionScope(input: SesPutSuppressionScopeInput): Promise<void>;

  // -- Configuration set (PRD 05, PRD 06) -----------------------------------

  createConfigurationSet(input: SesCreateConfigurationSetInput): Promise<void>;
  deleteConfigurationSet(input: SesConfigurationSetRef): Promise<void>;
  /**
   * A PUT — and the only verb here that is not one AWS operation.
   *
   * SESv2 offers `CreateConfigurationSetEventDestination` and
   * `UpdateConfigurationSetEventDestination` and NO `Put`. Since PRD 06
   * requires provisioning to be resumable, the create-then-update-on-exists
   * dance lives here rather than in every caller. The next reader will look
   * for a `PutConfigurationSetEventDestination`: it does not exist.
   */
  putEventDestination(input: SesPutEventDestinationInput): Promise<void>;

  // -- Identity (PRD 07) ----------------------------------------------------

  createIdentity(input: SesCreateIdentityInput): Promise<SesIdentity>;
  getIdentity(input: SesIdentityRef): Promise<SesIdentity>;
  setMailFrom(input: SesSetMailFromInput): Promise<void>;
  deleteIdentity(input: SesIdentityRef): Promise<void>;

  // -- Reputation (PRD 08) --------------------------------------------------

  setReputationPolicy(input: SesSetReputationPolicyInput): Promise<void>;
  setTenantSendingStatus(input: SesSetTenantSendingStatusInput): Promise<void>;
  /** The reconciliation read — see {@link SesReputationEntity} for why a
   * write-only reputation surface fails OPEN. */
  getReputationEntity(
    input: SesReputationEntityRef,
  ): Promise<SesReputationEntity>;
  listRecommendations(
    input?: SesListRecommendationsInput,
  ): Promise<SesRecommendationsPage>;

  // -- Account (PRD 06's activation gate) -----------------------------------

  /**
   * "Can this account send mail?", which is NOT the same question as "do we
   * hold AWS credentials" — see {@link SesAccount}. Read once per region and
   * cached (`services/ses-availability.ts`); no provision pays a round trip
   * for it.
   */
  getAccount(): Promise<SesAccount>;
}

/** Every verb on the seam, minus the three identity properties. */
export type SesVerb = Exclude<keyof SesClient, "id" | "region" | "awsRegion">;

/**
 * The verbs, as a runtime value.
 *
 * It exists so a test can assert the SURFACE — twenty verbs, both
 * implementations answering all of them. A verb quietly dropped from the
 * interface takes its callers' behaviour with it and nothing else notices,
 * because a Fake that no longer has a method is just a Fake nobody calls.
 */
export const SES_VERBS = [
  "sendEmail",
  "sendBatch",
  "createTenant",
  "getTenant",
  "deleteTenant",
  "associateResource",
  "disassociateResource",
  "putSuppressionScope",
  "createConfigurationSet",
  "deleteConfigurationSet",
  "putEventDestination",
  "createIdentity",
  "getIdentity",
  "setMailFrom",
  "deleteIdentity",
  "setReputationPolicy",
  "setTenantSendingStatus",
  "getReputationEntity",
  "listRecommendations",
  "getAccount",
] as const satisfies readonly SesVerb[];

/** Compile-time exhaustiveness: adding a verb to `SesClient` without adding it
 * to `SES_VERBS` makes this a type error, so the two cannot drift. */
type AssertNever<T extends never> = T;
type _EveryVerbIsListed = AssertNever<
  Exclude<SesVerb, (typeof SES_VERBS)[number]>
>;

/**
 * `SubstrateRegion` → SES region, and a hard refusal for anything else.
 *
 * SES tenants are region-scoped and do not replicate, so a client that could
 * silently target the wrong region is a correctness bug waiting to happen: the
 * tenant would be minted somewhere nobody looks again, and the failure would
 * surface as "the customer's domain never verifies" rather than as a
 * misconfiguration.
 *
 * Takes a `string` rather than a `SubstrateRegion` on purpose — the value
 * usually arrives from a database column, where the type system has already
 * stopped helping.
 */
export function resolveSesRegion(region: string): SesRegion {
  const resolved = (
    SES_REGION_BY_SUBSTRATE_REGION as Record<string, SesRegion | undefined>
  )[region];
  if (!resolved) {
    throw new SesError(
      `unsupported SES region ${JSON.stringify(region)}; expected one of ${Object.keys(
        SES_REGION_BY_SUBSTRATE_REGION,
      ).join(", ")}`,
      { kind: "invalid" },
    );
  }
  return resolved;
}
