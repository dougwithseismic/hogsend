import { handleSesEventNotification } from "@/src/lib/email-event-ingress";

/**
 * `POST /api/email/events/[region]` — the SNS subscription endpoint SES's
 * configuration sets publish delivery, bounce, complaint and delay events to
 * (PRD 05 task 3).
 *
 * One endpoint per region because SES tenants are region-scoped and do not
 * replicate (DECISIONS §3.3), so `us` and `eu` events arrive on different
 * topics and the region is what says which topic is the expected one.
 *
 * Three lines, deliberately. Everything the endpoint DOES lives in
 * `src/lib/email-event-ingress.ts`, for the reason `/api/email/send` gives:
 * the order of operations here IS a security posture, and a copy of it living
 * in a route file is a copy that can quietly lose a step.
 *
 * NOT in `src/openapi.ts` — that file describes the UNAUTHENTICATED surface,
 * and this route's caller is AWS, authenticated by an SNS signature.
 */

// Verifies a signature, writes to the database and calls out to a tenant
// instance; nothing about it may be cached or prerendered.
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ region: string }> },
): Promise<Response> {
  const { region } = await context.params;
  return handleSesEventNotification(request, region);
}
