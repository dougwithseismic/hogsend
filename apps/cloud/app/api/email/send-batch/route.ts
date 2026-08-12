import { handleRelaySendBatch } from "@/src/lib/email-relay";

/**
 * `POST /api/email/send-batch` — many messages on one round trip (PRD 03
 * task 5).
 *
 * Two endpoints rather than one polymorphic one, because the two have
 * genuinely different answers: `send` returns `{ id }` or a status, and this
 * returns one result PER ITEM, positionally, where a partial failure is a
 * successful response rather than a failed one.
 *
 * The behaviour, and the reasoning behind the order it happens in, live in
 * `src/lib/email-relay.ts` — including the decision that matters most here,
 * that idempotency is per ITEM and never per request.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleRelaySendBatch(request);
}
