import { handleDomainInbound } from "@/src/lib/email-domains";

/**
 * `POST /api/email/domains/inbound` — inbound replies, on and off (PRD 16).
 *
 * OFF by default and reversible, like the return path: on adds exactly one
 * record (an MX at `reply.<domain>`), off removes only this domain's names and
 * forgets the forwarding address. The record is always a SUBDOMAIN — a customer
 * apex MX is their real company mailbox, and repointing it at SES would delete
 * their company email rather than add replies.
 *
 * NOT the SNS receive endpoint: mail arrives at
 * `/api/email/inbound/[region]`, which is a different wire with different auth.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleDomainInbound(request);
}
