import { handleRelaySend } from "@/src/lib/email-relay";

/**
 * `POST /api/email/send` — the control-plane endpoint a tenant instance calls
 * to send one message (PRD 03 task 4).
 *
 * This file is deliberately three lines. Everything the endpoint DOES lives in
 * `src/lib/email-relay.ts`, because `send-batch` has to make the same decisions
 * in the same order, and two route files each holding their own copy of an
 * ordering that is a security posture is how one of them quietly loses a step.
 *
 * NOT in `src/openapi.ts`, and that is the documented rule rather than an
 * omission: that file describes the UNAUTHENTICATED surface, and the
 * token-authenticated machine routes (`/api/cli/*`, `/api/publish/*`,
 * `/api/builds/*`) are excluded because our own software is their only
 * consumer. The relay is exactly that kind of route.
 */

// Reads a bearer credential and writes to the database and to SES; nothing
// about it may be cached or prerendered.
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleRelaySend(request);
}
