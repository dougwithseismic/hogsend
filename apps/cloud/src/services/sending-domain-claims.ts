import { and, eq, isNull, sql } from "drizzle-orm";
import { sendingDomains } from "../db/schema";
import type { CloudWriter } from "./audit";
import { isUniqueViolation } from "./errors";

/**
 * Row access for `sending_domains` — the deed to a sending domain in the shared
 * AWS account.
 *
 * DATA ONLY, and deliberately policy-free: nothing here decides whether a
 * caller may have a domain, and nothing here throws {@link
 * import("./ses-domains").DomainNotOwnedError}. That judgement lives in
 * `ses-domains.ts` with the rest of the sending-domain rules.
 *
 * It is its own module for one structural reason: BOTH `ses-domains.ts` (which
 * takes claims) and `ses-tenants.ts` (which releases them at teardown) need
 * these queries, and `ses-domains.ts` already imports `ses-tenants.ts` for the
 * tenancy lookup. Putting the queries in either one would make that import
 * cycle.
 */

/** A live claim on a sending domain — the row that answers "whose is this?". */
export interface SendingDomainClaim {
  id: string;
  organizationId: string;
  /** The environment that FIRST registered it. NULL once that one is deleted. */
  environmentId: string | null;
  domain: string;
  /** The SES region the identity lives in. */
  awsRegion: string;
}

/** The columns a claim is made of. One list, so every read agrees. */
const claimColumns = {
  id: sendingDomains.id,
  organizationId: sendingDomains.organizationId,
  environmentId: sendingDomains.environmentId,
  domain: sendingDomains.domain,
  awsRegion: sendingDomains.awsRegion,
} as const;

/**
 * The LIVE claim on `domain`, or `null`.
 *
 * Expects a NORMALIZED domain: claims are stored under the normalized name, so
 * a caller that skipped normalization would ask about a name nobody has claimed
 * and read `null` for the wrong reason.
 */
export async function readSendingDomainClaim(
  writer: CloudWriter,
  domain: string,
): Promise<SendingDomainClaim | null> {
  const [row] = await writer
    .select(claimColumns)
    .from(sendingDomains)
    .where(
      and(eq(sendingDomains.domain, domain), isNull(sendingDomains.releasedAt)),
    )
    .limit(1);
  return row ?? null;
}

/** Every domain this organization currently holds. The release path's read. */
export async function listSendingDomainClaims(
  writer: CloudWriter,
  organizationId: string,
): Promise<SendingDomainClaim[]> {
  return writer
    .select(claimColumns)
    .from(sendingDomains)
    .where(
      and(
        eq(sendingDomains.organizationId, organizationId),
        isNull(sendingDomains.releasedAt),
      ),
    )
    .orderBy(sendingDomains.domain);
}

/**
 * Try to take the claim. Answers the inserted row, or `null` when somebody
 * already holds a live claim on this domain — WHOEVER that is.
 *
 * The insert races through the table's PARTIAL unique index, whose predicate is
 * restated here as the arbiter (`where`). Postgres matches an arbiter by
 * predicate rather than by name, so omitting it would fail to find the index
 * and the conflict would surface as an error instead of a no-op. The 23505
 * catch is the belt to that brace — `isUniqueViolation` walks `err.cause`,
 * because postgres.js nests the driver error.
 *
 * `null` is not a failure here, only a fact. The caller re-reads to learn who
 * won, because losing this race to one's OWN organization (two environments
 * adding a domain at the same moment) is an ordinary success.
 */
export async function insertSendingDomainClaim(input: {
  writer: CloudWriter;
  organizationId: string;
  environmentId: string;
  domain: string;
  awsRegion: string;
}): Promise<SendingDomainClaim | null> {
  try {
    const [row] = await input.writer
      .insert(sendingDomains)
      .values({
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        domain: input.domain,
        awsRegion: input.awsRegion,
      })
      .onConflictDoNothing({
        target: sendingDomains.domain,
        where: sql`released_at IS NULL`,
      })
      .returning(claimColumns);
    return row ?? null;
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}

/**
 * Give up every domain this organization holds, as of `now`.
 *
 * SOFT: the row stays with `released_at` set, so "who was sending from this six
 * months ago" still has an answer — the question an abuse investigation asks,
 * which a hard delete answers with silence.
 *
 * Callers MUST have deleted the SES identity FIRST. A claim released while its
 * identity survives is a domain nobody can ever take again.
 */
export async function releaseSendingDomains(input: {
  writer: CloudWriter;
  organizationId: string;
  now?: Date;
}): Promise<SendingDomainClaim[]> {
  const at = input.now ?? new Date();
  return input.writer
    .update(sendingDomains)
    .set({ releasedAt: at, updatedAt: at })
    .where(
      and(
        eq(sendingDomains.organizationId, input.organizationId),
        isNull(sendingDomains.releasedAt),
      ),
    )
    .returning(claimColumns);
}
