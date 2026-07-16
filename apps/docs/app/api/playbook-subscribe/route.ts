import { NextResponse } from "next/server";
import {
  boundedText,
  EMAIL_PATTERN,
  forwardToIngest,
  ingestConfigured,
} from "@/lib/ingest";

const FIRST_NAME_MAX_LENGTH = 80;

/**
 * POST /api/playbook-subscribe — the playbook's "one play a week" capture.
 * Accepts { email, firstName?, termsAccepted } and forwards a
 * `playbook.subscribed` event to the Hogsend ingest API with an explicit
 * `playbook-weekly` list opt-in. The dogfood's `playbook-weekly` journey
 * enrolls on the event and sends the rotation; leaving the list fail-closes
 * every later send. Mirrors /api/subscribe, minus the demo identity
 * threading the playbook doesn't need.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!ingestConfigured()) {
    return NextResponse.json(
      { error: "capture not configured" },
      { status: 503 },
    );
  }

  let email: unknown;
  let firstName: string | undefined;
  let termsAccepted = false;
  try {
    const body = (await request.json()) as {
      email?: unknown;
      firstName?: unknown;
      termsAccepted?: unknown;
    };
    email = body?.email;
    firstName = boundedText(body?.firstName, FIRST_NAME_MAX_LENGTH);
    termsAccepted = body?.termsAccepted === true;
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  if (typeof email !== "string" || !EMAIL_PATTERN.test(email.trim())) {
    return NextResponse.json({ error: "invalid email" }, { status: 400 });
  }
  if (!termsAccepted) {
    // The list is opt-in only — a submit without the consent box is a bug
    // in the client, not a subscription.
    return NextResponse.json({ error: "consent required" }, { status: 400 });
  }

  const normalizedEmail = email.trim().toLowerCase();

  const accepted = await forwardToIngest(
    {
      name: "playbook.subscribed",
      email: normalizedEmail,
      contactProperties: {
        ...(firstName ? { firstName } : {}),
      },
      eventProperties: {
        source: "playbook",
        termsAccepted,
      },
      lists: { "playbook-weekly": true },
    },
    `playbook-subscribed-${normalizedEmail}`,
  );

  if (!accepted) {
    return NextResponse.json({ error: "upstream failed" }, { status: 502 });
  }

  return NextResponse.json({ ok: true }, { status: 202 });
}
