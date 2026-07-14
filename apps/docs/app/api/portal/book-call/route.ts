import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  boundedText,
  forwardToIngest,
  ingestConfigured,
  SUBMISSION_ID_MAX,
  truncatedText,
} from "@/lib/ingest";

export const runtime = "nodejs";

const NAME_MAX = 80;
const MESSAGE_MAX = 1000;

/**
 * POST /api/portal/book-call — the signed-in customer's "book a call" from
 * the portal. Identity comes from the verified session (never the body); the
 * only caller input is the note. Emits the same `service.call_requested`
 * event as the public /service form with `source: "portal"` — but the
 * CUSTOMER register is decided journey-side from purchase truth
 * (service_purchases), never from this stamp, so a free account (or a forged
 * event) still gets the prospect treatment.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!ingestConfigured()) {
    return NextResponse.json(
      { error: "capture not configured" },
      { status: 503 },
    );
  }
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  // Truncated, not dropped — a client bypassing the UI cap still gets its
  // note (cut short) in front of the operator instead of a silent 202.
  const message = truncatedText(body?.message, MESSAGE_MAX);
  const submissionId = boundedText(body?.submissionId, SUBMISSION_ID_MAX);

  const email = session.user.email.trim().toLowerCase();
  const name = truncatedText(session.user.name, NAME_MAX);

  const accepted = await forwardToIngest(
    {
      name: "service.call_requested",
      email,
      userId: session.user.id,
      // firstName is what the confirmation greeting + operator alert read.
      contactProperties: { ...(name ? { firstName: name } : {}) },
      eventProperties: {
        source: "portal",
        // The Better Auth id for the journey's purchase lookup — its
        // `user.id` is the resolved CONTACT key, which differs from the
        // checkout-stamped id for aliased contacts.
        authUserId: session.user.id,
        ...(message ? { message } : {}),
      },
    },
    // Per-mount submission id dedupes a double-click into one request; the
    // dedupe key is stored permanently, so an ABSENT id gets a fresh UUID —
    // a constant fallback would tombstone every future id-less request.
    `portal-call-${email}-${submissionId ?? crypto.randomUUID()}`,
  );

  if (!accepted) {
    return NextResponse.json({ error: "upstream failed" }, { status: 502 });
  }
  return NextResponse.json({ ok: true }, { status: 202 });
}
