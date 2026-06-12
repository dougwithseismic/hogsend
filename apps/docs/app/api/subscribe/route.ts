import { NextResponse } from "next/server";
import { EMAIL_PATTERN, forwardToIngest, ingestConfigured } from "@/lib/ingest";

const FIRST_NAME_MAX_LENGTH = 80;
const DISTINCT_ID_MAX_LENGTH = 200;

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
 * sanitizeDistinctId — the PostHog anonymous distinct_id of the subscribing
 * session, stored as a contact property so the anonymous browsing trail can
 * be joined to the contact later. Optional and best-effort.
 */
function sanitizeDistinctId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > DISTINCT_ID_MAX_LENGTH) {
    return undefined;
  }
  return trimmed;
}

/**
 * POST /api/subscribe — accepts { email, firstName?, posthogDistinctId? }
 * and forwards a `docs.subscribed` lifecycle event to the external Hogsend
 * ingest API, carrying the first name (so journey templates can greet by
 * name) and the session's PostHog distinct_id as contact properties.
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
  let posthogDistinctId: string | undefined;
  let termsAccepted = false;
  let productNotes = false;
  try {
    const body = (await request.json()) as {
      email?: unknown;
      firstName?: unknown;
      posthogDistinctId?: unknown;
      termsAccepted?: unknown;
      productNotes?: unknown;
    };
    email = body?.email;
    firstName = sanitizeFirstName(body?.firstName);
    posthogDistinctId = sanitizeDistinctId(body?.posthogDistinctId);
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
      name: "docs.subscribed",
      email: normalizedEmail,
      contactProperties: {
        ...(firstName ? { firstName } : {}),
        ...(posthogDistinctId ? { posthogDistinctId } : {}),
      },
      // termsAccepted is recorded on the event as the consent audit trail.
      eventProperties: { source: "docs-site", termsAccepted },
      // product-updates membership ONLY on the explicit, unticked-by-default
      // checkbox — unbundled consent, recorded at the point of capture.
      ...(productNotes ? { lists: { "product-updates": true } } : {}),
    },
    `docs-subscribed-${normalizedEmail}`,
  );

  if (!accepted) {
    return NextResponse.json({ error: "upstream failed" }, { status: 502 });
  }

  // The canonical contact key (no PII) rides back so the client can
  // posthog.identify() the session — joining this visit to the PostHog person
  // the contact's email-lifecycle events land on.
  return NextResponse.json(
    {
      ok: true,
      ...(accepted.contactKey ? { contactKey: accepted.contactKey } : {}),
    },
    { status: 202 },
  );
}
