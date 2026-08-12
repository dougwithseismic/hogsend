import { handleDomainReturnPath } from "@/src/lib/email-domains";

/**
 * `POST /api/email/domains/return-path` — the branded return path toggle.
 *
 * OFF by default, and reversible: on adds exactly two records (an MX and an SPF
 * TXT at `send.<domain>`), off reverts the identity to SES's default return
 * path and drops them again. The MAIL FROM behaviour is always
 * `USE_DEFAULT_VALUE` — a customer's MX breaking six months from now must
 * degrade to the default return path, never stop their mail.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleDomainReturnPath(request);
}
