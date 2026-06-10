import { NextResponse } from "next/server";

/** Loose shape check — the upstream ingest API does the real validation. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const FIRST_NAME_MAX_LENGTH = 80;

/**
 * sanitizeFirstName — trims and bounds the optional first name. Anything
 * odd (not a string, empty, too long) is dropped rather than rejected: a
 * dodgy first name must never block the subscription itself.
 */
function sanitizeFirstName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > FIRST_NAME_MAX_LENGTH) {
    return undefined;
  }
  return trimmed;
}

/**
 * POST /api/subscribe — accepts { email, firstName? } and forwards a
 * `docs.subscribed` lifecycle event to the external Hogsend ingest API,
 * carrying the first name as a contact property so journey templates can
 * greet by name. The ingest key never leaves the server; without
 * HOGSEND_INGEST_URL + HOGSEND_INGEST_KEY the route answers 503 so the
 * client can fail quietly.
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
  let firstName: string | undefined;
  try {
    const body = (await request.json()) as {
      email?: unknown;
      firstName?: unknown;
    };
    email = body?.email;
    firstName = sanitizeFirstName(body?.firstName);
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
        contactProperties: firstName ? { firstName } : {},
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
