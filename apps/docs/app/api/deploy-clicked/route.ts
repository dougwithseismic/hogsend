import { NextResponse } from "next/server";
import { EMAIL_PATTERN, forwardToIngest, ingestConfigured } from "@/lib/ingest";

/**
 * POST /api/deploy-clicked — forwards `docs.deploy_clicked` to the Hogsend
 * ingest API. Called fire-and-forget when a visitor who subscribed earlier
 * in this browsing session clicks a Railway deploy CTA; the docs-subscriber
 * journey reads the event to skip its day-2 nudge. Anonymous visitors never
 * hit this route — their deploy clicks live in PostHog only.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!ingestConfigured()) {
    return NextResponse.json(
      { error: "capture not configured" },
      { status: 503 },
    );
  }

  let email: unknown;
  try {
    const body = (await request.json()) as { email?: unknown };
    email = body?.email;
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  if (typeof email !== "string" || !EMAIL_PATTERN.test(email.trim())) {
    return NextResponse.json({ error: "invalid email" }, { status: 400 });
  }

  const normalizedEmail = email.trim().toLowerCase();
  // Day-stamped idempotency: repeat clicks the same day dedupe, a click on
  // a later day still records (the journey checks a rolling 2-day window).
  const day = new Date().toISOString().slice(0, 10);

  const ok = await forwardToIngest(
    {
      name: "docs.deploy_clicked",
      email: normalizedEmail,
      eventProperties: { source: "docs-site" },
    },
    `docs-deploy-clicked-${day}-${normalizedEmail}`,
  );

  if (!ok) {
    return NextResponse.json({ error: "upstream failed" }, { status: 502 });
  }
  return NextResponse.json({ ok: true }, { status: 202 });
}
