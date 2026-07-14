import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  boundedText,
  forwardToIngest,
  ingestConfigured,
  SUBMISSION_ID_MAX,
} from "@/lib/ingest";

export const runtime = "nodejs";

const MESSAGE_MAX = 1000;

/**
 * POST /api/portal/book-call — the signed-in customer's "book a call" from
 * the portal. Identity comes from the verified session (never the body); the
 * only caller input is the note. Emits the same `service.call_requested`
 * event as the public /service form, with `source: "portal"` switching the
 * journey to the customer register — the journey also enriches the operator
 * alert with the customer's purchased plans there, off this hot path.
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
  const message = boundedText(body?.message, MESSAGE_MAX);
  const submissionId = boundedText(body?.submissionId, SUBMISSION_ID_MAX);

  const email = session.user.email.trim().toLowerCase();
  const accepted = await forwardToIngest(
    {
      name: "service.call_requested",
      email,
      userId: session.user.id,
      eventProperties: {
        source: "portal",
        ...(session.user.name ? { name: session.user.name } : {}),
        ...(message ? { message } : {}),
      },
    },
    // Per-mount submission id dedupes a double-click into one request; a
    // genuine re-request from a fresh visit carries a new id.
    `portal-call-${email}-${submissionId ?? "na"}`,
  );

  if (!accepted) {
    return NextResponse.json({ error: "upstream failed" }, { status: 502 });
  }
  return NextResponse.json({ ok: true }, { status: 202 });
}
