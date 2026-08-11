import { db as defaultDb } from "../db";
import { writeAudit } from "../services/audit";
import { readTrustTier } from "../services/email-trust-tiers";
import { allowsBulkImport, type EmailTrustTier } from "./email-abuse-policy";
import { type RelayDeps, resolveRelayCaller } from "./email-relay";

/**
 * THE BULK-IMPORT BLOCK (PRD 08 task 6, AUP §5.3).
 *
 * DECISIONS §8 calls this the single highest-value abuse control in the stack,
 * because the scraped-list blast is the specific event that damages aggregate
 * reputation fastest — faster than a bad journey, faster than a leaked token,
 * faster than anything a rate limit bounds. An environment with no established
 * sending record cannot perform a large first send to a list we have never
 * seen.
 *
 * **It is a STRUCTURAL block, not a rate limit.** There is no size at which a
 * `new` tenant's import is fine, no burst allowance, and no way to buy past it.
 * The refusal names the tier requirement, because "not allowed" leaves a
 * legitimate customer with nothing to act on and §5.3 promises the requirement
 * is stated.
 *
 * **Why the control plane owns the decision.** A tenant instance holds its own
 * contacts and does its own importing; what it does NOT hold is its trust tier,
 * which is a fact about its SES tenancy and lives here with the credential.
 * So the instance asks and the control plane answers, exactly as it does for
 * domains (PRD 07) and for sends — the same relay token, the same posture.
 *
 * Refusals are audited. AUP §6.4 reviews "repeated refusal attempts", which is
 * only a reviewable signal if the attempts are recorded.
 */

export const BULK_IMPORT_REQUIRED_TIER: EmailTrustTier = "established";

export const BULK_IMPORT_REFUSED_ACTION = "email_bulk_import.refused";

export interface BulkImportVerdict {
  allowed: boolean;
  tier: EmailTrustTier;
  requiredTier: EmailTrustTier;
  reason?: "bulk_import_blocked";
  message?: string;
}

/**
 * May this tier bulk-import? Pure, so the whole rule is one assertion away.
 */
export function decideBulkImport(input: {
  tier: EmailTrustTier;
}): BulkImportVerdict {
  if (allowsBulkImport(input.tier)) {
    return {
      allowed: true,
      tier: input.tier,
      requiredTier: BULK_IMPORT_REQUIRED_TIER,
    };
  }
  return {
    allowed: false,
    tier: input.tier,
    requiredTier: BULK_IMPORT_REQUIRED_TIER,
    reason: "bulk_import_blocked",
    message: `Bulk list import is not available on the ${input.tier} trust tier. It becomes available at the established tier, which this environment reaches automatically once it has a clean sending record (Acceptable Use Policy §5.3). This is a block rather than a limit: no import size is permitted below that tier.`,
  };
}

/**
 * `POST /api/email/bulk-import` — the tenant instance asking whether it may.
 *
 * Authenticated with the relay token, exactly like the send and domain routes:
 * the token resolves an ENVIRONMENT and the environment determines the tier, so
 * a request cannot name a tier or an environment of its own.
 */
export async function handleBulkImportCheck(
  request: Request,
  deps: RelayDeps = {},
): Promise<Response> {
  const db = deps.db ?? defaultDb;

  const auth = await resolveRelayCaller(request, deps);
  if (!auth.ok) return auth.response;
  const { caller } = auth;

  const tier = await readTrustTier({ environmentId: caller.environmentId, db });
  const verdict = decideBulkImport({ tier });

  if (verdict.allowed) {
    return Response.json(
      { allowed: true, tier: verdict.tier },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }

  // §6.4's repeat-attempt review needs the attempts on the record.
  await writeAudit(db, {
    actor: "relay",
    organizationId: caller.organizationId,
    action: BULK_IMPORT_REFUSED_ACTION,
    subject: caller.environmentId,
    detail: { tier: verdict.tier, requiredTier: verdict.requiredTier },
  }).catch((error: unknown) => {
    // A missing audit row must not turn a refusal into an acceptance.
    console.error(
      `[cloud:email-bulk-import] audit write failed for environment ${caller.environmentId}:`,
      error,
    );
  });

  return Response.json(
    {
      error: verdict.reason,
      message: verdict.message,
      tier: verdict.tier,
      requiredTier: verdict.requiredTier,
    },
    { status: 403, headers: { "cache-control": "no-store" } },
  );
}
