import { NextResponse } from "next/server";

/** Loose shape check — the upstream ingest API does the real validation. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /api/subscribe — accepts { email } and forwards a `docs.subscribed`
 * lifecycle event to the external Hogsend ingest API. The ingest key never
 * leaves the server; without HOGSEND_INGEST_URL + HOGSEND_INGEST_KEY the
 * route answers 503 so the client can fail quietly.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const ingestUrl = process.env.HOGSEND_INGEST_URL;
  const ingestKey = process.env.HOGSEND_INGEST_KEY;

  if (!ingestUrl || !ingestKey) {
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

  try {
    const upstream = await fetch(`${ingestUrl.replace(/\/+$/, "")}/v1/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ingestKey}`,
        "Idempotency-Key": `docs-subscribed-${normalizedEmail}`,
      },
      body: JSON.stringify({
        name: "docs.subscribed",
        email: normalizedEmail,
        eventProperties: { source: "docs-site" },
        contactProperties: {},
        lists: { "product-updates": true },
      }),
    });

    if (!upstream.ok) {
      return NextResponse.json({ error: "upstream failed" }, { status: 502 });
    }
  } catch {
    return NextResponse.json({ error: "upstream failed" }, { status: 502 });
  }

  return NextResponse.json({ ok: true }, { status: 202 });
}
