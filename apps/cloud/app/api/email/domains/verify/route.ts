import { handleDomainVerify } from "@/src/lib/email-domains";

/**
 * `POST /api/email/domains/verify` — re-read one domain's status from SES.
 *
 * SES has no "verify now" operation (DKIM verification is a poll AWS runs
 * itself), so this is a fresh read. It exists as its own endpoint because
 * `DomainsCapability.verify` is part of the contract every surface calls, and a
 * domain that was never created answers `state: "not_found"` rather than 404.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleDomainVerify(request);
}
