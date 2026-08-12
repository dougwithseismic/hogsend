import { handleSesInboundNotification } from "@/src/lib/email-inbound-ingress";

/**
 * `POST /api/email/inbound/[region]` — the SNS subscription endpoint the SES
 * receipt rules publish a RECEIVED message to (PRD 16 task 4).
 *
 * One endpoint per region, like the status ingress next door, because receipt
 * rule sets are region-scoped and each region publishes to its own topic — the
 * region in the path is what says which topic is the expected one.
 *
 * Three lines, deliberately. Everything the endpoint DOES lives in
 * `src/lib/email-inbound-ingress.ts`, for the reason `/api/email/events` gives:
 * the order of operations IS a security posture, and a copy of it living in a
 * route file is a copy that can quietly lose a step. Here that matters more
 * than anywhere else in the control plane, because the payload downstream of
 * this route is raw MIME written by strangers.
 *
 * NOT in `src/openapi.ts` — that file describes the UNAUTHENTICATED surface,
 * and this route's caller is AWS, authenticated by an SNS signature.
 */

// Verifies a signature, reads from S3, writes to the database and calls out to
// a tenant instance; nothing about it may be cached or prerendered.
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ region: string }> },
): Promise<Response> {
  const { region } = await context.params;
  return handleSesInboundNotification(request, region);
}
