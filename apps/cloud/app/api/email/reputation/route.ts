import { handleSesAbuseEvent } from "@/src/lib/email-abuse-ingress";

/**
 * `POST /api/email/reputation` — the EventBridge API destination's endpoint
 * (PRD 08 task 1).
 *
 * No region segment, unlike PRD 05's `/api/email/events/[region]`. SNS topics
 * are per region and the topic ARN is what authenticates a notification, so
 * that endpoint HAS to know which region it is serving. A reputation event
 * names its own tenant, and a tenant name resolves to the one environment that
 * owns it and to the region that environment's tenancy was pinned in — so a
 * region in the path would be a second source of truth for something the event
 * already answers, and the two could disagree.
 *
 * Three lines, like the send relay's: everything lives in
 * `src/lib/email-abuse-ingress.ts`, so an ordering that is a security posture
 * is written once.
 *
 * NOT in `src/openapi.ts`: that file describes the UNAUTHENTICATED surface, and
 * this is a machine route whose only consumer is AWS.
 */

// Authenticates a shared secret and writes tenant state; never cached.
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleSesAbuseEvent(request);
}
