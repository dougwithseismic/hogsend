import { NextResponse } from "next/server";
import {
  boundedText,
  EMAIL_PATTERN,
  forwardToIngest,
  ingestConfigured,
  SUBMISSION_ID_MAX,
  truncatedText,
} from "@/lib/ingest";

const NAME_MAX = 80;
const COMPANY_MAX = 120;
const MESSAGE_MAX = 1000;

/**
 * POST /api/service-inquiry — the done-for-you "request a call" form. Forwards
 * a `service.call_requested` lifecycle event into Hogsend, carrying the
 * prospect's email + name (contact) and their company + note (event props, so
 * the dogfood journey can read them). That journey sends the prospect an
 * instant confirmation with a booking link and notifies the operator — the
 * whole booking lifecycle runs on Hogsend itself. No account required.
 */

export async function POST(request: Request): Promise<NextResponse> {
  if (!ingestConfigured()) {
    return NextResponse.json(
      { error: "capture not configured" },
      { status: 503 },
    );
  }

  let email: unknown;
  let name: string | undefined;
  let company: string | undefined;
  let message: string | undefined;
  let submissionId: string | undefined;
  let termsAccepted = false;
  let productNotes = false;
  try {
    const body = (await request.json()) as {
      email?: unknown;
      name?: unknown;
      company?: unknown;
      message?: unknown;
      submissionId?: unknown;
      termsAccepted?: unknown;
      productNotes?: unknown;
    };
    email = body?.email;
    name = boundedText(body?.name, NAME_MAX);
    company = boundedText(body?.company, COMPANY_MAX);
    // Truncated, not dropped — an over-long note still reaches the operator.
    message = truncatedText(body?.message, MESSAGE_MAX);
    submissionId = boundedText(body?.submissionId, SUBMISSION_ID_MAX);
    termsAccepted = body?.termsAccepted === true;
    productNotes = body?.productNotes === true;
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  if (typeof email !== "string" || !EMAIL_PATTERN.test(email.trim())) {
    return NextResponse.json({ error: "invalid email" }, { status: 400 });
  }

  const normalizedEmail = email.trim().toLowerCase();

  const accepted = await forwardToIngest(
    {
      name: "service.call_requested",
      email: normalizedEmail,
      contactProperties: {
        ...(name ? { firstName: name } : {}),
      },
      // Journeys read eventProperties (not contactProperties), so the operator
      // notification's context rides here as scalars.
      eventProperties: {
        source: "docs-service",
        plan: "dfy",
        // Consent audit trail, recorded at the point of capture.
        termsAccepted,
        ...(name ? { name } : {}),
        ...(company ? { company } : {}),
        ...(message ? { message } : {}),
      },
      // product-updates membership ONLY on the explicit, unticked-by-default
      // opt-in — unbundled consent.
      ...(productNotes ? { lists: { "product-updates": true } } : {}),
    },
    // Per-mount submission id dedupes a double-click into one lead; the key
    // is stored permanently, so an ABSENT id gets a fresh UUID — a constant
    // fallback would tombstone every future id-less enquiry from this email.
    `service-call-${normalizedEmail}-${submissionId ?? crypto.randomUUID()}`,
  );

  if (!accepted) {
    return NextResponse.json({ error: "upstream failed" }, { status: 502 });
  }

  return NextResponse.json({ ok: true }, { status: 202 });
}
