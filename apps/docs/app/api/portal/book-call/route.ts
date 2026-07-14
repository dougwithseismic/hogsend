import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { forwardToIngest, ingestConfigured } from "@/lib/ingest";
import { fetchServices } from "@/lib/services";

export const runtime = "nodejs";

const MESSAGE_MAX = 1000;
const SUBMISSION_ID_MAX = 100;

/**
 * POST /api/portal/book-call — the signed-in customer's "book a call" from
 * the portal. Identity comes from the verified session (never the body); the
 * only caller input is the note. Their current plans are read server-side so
 * the operator alert carries honest context. Emits the same
 * `service.call_requested` event as the public /service form, with
 * `source: "portal"` switching the journey to the customer register.
 */

/** Trim + bound an optional free-text field; drop anything odd rather than 400. */
function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

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
  const services = await fetchServices({ email, userId: session.user.id });
  const plans = services
    ?.map((s) => (s.status ? `${s.plan} (${s.status})` : s.plan))
    .join(", ");

  const accepted = await forwardToIngest(
    {
      name: "service.call_requested",
      email,
      userId: session.user.id,
      eventProperties: {
        source: "portal",
        customer: true,
        ...(session.user.name ? { name: session.user.name } : {}),
        ...(plans ? { plans } : {}),
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
