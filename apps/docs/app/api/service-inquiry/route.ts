import { NextResponse } from "next/server";
import { EMAIL_PATTERN, forwardToIngest, ingestConfigured } from "@/lib/ingest";

const NAME_MAX = 80;
const COMPANY_MAX = 120;
const MESSAGE_MAX = 1000;
const SUBMISSION_ID_MAX = 100;

/**
 * POST /api/service-inquiry — the done-for-you "request a call" form. Forwards
 * a `service.call_requested` lifecycle event into Hogsend, carrying the
 * prospect's email + name (contact) and their company + note (event props, so
 * the dogfood journey can read them). That journey sends the prospect an
 * instant confirmation with a booking link and notifies the operator — the
 * whole booking lifecycle runs on Hogsend itself. No account required.
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

  let email: unknown;
  let name: string | undefined;
  let company: string | undefined;
  let message: string | undefined;
  let submissionId: string | undefined;
  try {
    const body = (await request.json()) as {
      email?: unknown;
      name?: unknown;
      company?: unknown;
      message?: unknown;
      submissionId?: unknown;
    };
    email = body?.email;
    name = boundedText(body?.name, NAME_MAX);
    company = boundedText(body?.company, COMPANY_MAX);
    message = boundedText(body?.message, MESSAGE_MAX);
    submissionId = boundedText(body?.submissionId, SUBMISSION_ID_MAX);
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
        ...(name ? { name } : {}),
        ...(company ? { company } : {}),
        ...(message ? { message } : {}),
      },
    },
    // Per-mount submission id dedupes a double-click into one lead; a genuine
    // re-enquiry from a fresh visit carries a new id and goes through.
    `service-call-${normalizedEmail}-${submissionId ?? "na"}`,
  );

  if (!accepted) {
    return NextResponse.json({ error: "upstream failed" }, { status: 502 });
  }

  return NextResponse.json({ ok: true }, { status: 202 });
}
