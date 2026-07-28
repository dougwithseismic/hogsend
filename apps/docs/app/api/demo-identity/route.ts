import { NextResponse } from "next/server";
import {
  boundedText,
  EMAIL_PATTERN,
  forwardToIngest,
  ingestConfigured,
} from "@/lib/ingest";

const FIRST_NAME_MAX_LENGTH = 80;
const ANON_ID_MAX_LENGTH = 200;

/**
 * POST /api/demo-identity — the try-it demo's sign-up telling the engine who
 * just signed up. Accepts { email, name?, hsAnonId? } and forwards a
 * `docs.demo_signup` event carrying the email as the identity arm, so a real
 * person who signs up stops landing as a blank, email-less contact row.
 *
 * The event name is deliberately NEW and unlistened-to: `/api/subscribe`'s
 * `docs.subscribed` drives a real welcome email, and an inline demo gate is
 * not a newsletter opt-in.
 *
 * `hsAnonId` (the @hogsend/js browser id) rides as an INERT SCALAR event
 * property — never as the top-level `anonymousId` identity arm. This route is
 * unauthenticated and the email is unverified, while the server-side ingest
 * key is a SECRET key, which does not set the engine's anon-only clamp. A
 * client-supplied `anonymousId` under that key would therefore let anyone POST
 * a victim's email with their own browser id, fold that id onto the victim's
 * contact, and then read the victim's feed — the feed's recipient resolver
 * treats a raw anon id as sufficient to read. Folding an unverified EMAIL
 * creates at worst a junk contact; folding an attacker-chosen ANON ID grants a
 * capability. `/api/subscribe` passes `hsAnonId` the same inert way for the
 * same reason: the browser id is only ever attached to a contact by an
 * email-verified cold-connect confirm link the recipient clicks in their own
 * inbox.
 *
 * Best-effort by contract: the caller unlocks the demo regardless of the
 * status here, so a 502/503 must stay quiet and never echo the ingest key.
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
  let hsAnonId: string | undefined;
  try {
    const body = (await request.json()) as {
      email?: unknown;
      name?: unknown;
      hsAnonId?: unknown;
    };
    email = body?.email;
    firstName = boundedText(body?.name, FIRST_NAME_MAX_LENGTH);
    hsAnonId = boundedText(body?.hsAnonId, ANON_ID_MAX_LENGTH);
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  if (typeof email !== "string" || !EMAIL_PATTERN.test(email.trim())) {
    return NextResponse.json({ error: "invalid email" }, { status: 400 });
  }

  const normalizedEmail = email.trim().toLowerCase();

  const accepted = await forwardToIngest(
    {
      name: "docs.demo_signup",
      // The ONLY identity arm. No `anonymousId` — see the note above.
      email: normalizedEmail,
      contactProperties: {
        ...(firstName ? { firstName } : {}),
      },
      eventProperties: {
        source: "docs-demo",
        ...(hsAnonId ? { hsAnonId } : {}),
      },
    },
    `docs-demo-signup-${normalizedEmail}`,
  );

  if (!accepted) {
    return NextResponse.json({ error: "upstream failed" }, { status: 502 });
  }

  return NextResponse.json({ ok: true }, { status: 202 });
}
