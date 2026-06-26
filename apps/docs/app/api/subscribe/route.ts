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
 * session. Forwarded as the top-level `anonymousId` identity field so the
 * engine's resolver keys the contact on it: the returned `contactKey` then
 * equals this browser id and the session's anonymous events join the same
 * PostHog person with no merge call. Optional and best-effort.
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
 * name) as a contact property and the session's PostHog distinct_id as the
 * top-level `anonymousId` (the engine keys the contact on it, so the returned
 * `contactKey` equals the browser id — zero-merge identity threading).
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
  let hogsendAnonymousId: string | undefined;
  let termsAccepted = false;
  let productNotes = false;
  try {
    const body = (await request.json()) as {
      email?: unknown;
      firstName?: unknown;
      posthogDistinctId?: unknown;
      hogsendAnonymousId?: unknown;
      termsAccepted?: unknown;
      productNotes?: unknown;
    };
    email = body?.email;
    firstName = sanitizeFirstName(body?.firstName);
    posthogDistinctId = sanitizeDistinctId(body?.posthogDistinctId);
    // The @hogsend/js client's own `hs_anon_id` (the in-app demo's identity).
    // Rides on the event as the scalar `hsAnonId` so the dogfood's
    // `docs-link-demo` journey can email a cold-connect confirm link — clicking
    // it folds this browser id onto the contact (email-verified, not a value
    // fold from the public signup). See web-link.ts in hogsend-dogfood.
    hogsendAnonymousId = sanitizeDistinctId(body?.hogsendAnonymousId);
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
      // The browser anon id rides as top-level `anonymousId` (the engine
      // resolver's 2nd-precedence key), NOT as the inert contactProperties
      // entry it used to be — that property never stitched anything.
      ...(posthogDistinctId ? { anonymousId: posthogDistinctId } : {}),
      contactProperties: {
        ...(firstName ? { firstName } : {}),
      },
      // termsAccepted is recorded on the event as the consent audit trail.
      // hsAnonId (the in-app client's id) rides as a SCALAR event property so
      // the dogfood's docs-link-demo journey can read it (eventProperties reach
      // the journey; contactProperties don't) and email the confirm link.
      eventProperties: {
        source: "docs-site",
        termsAccepted,
        ...(hogsendAnonymousId ? { hsAnonId: hogsendAnonymousId } : {}),
      },
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
