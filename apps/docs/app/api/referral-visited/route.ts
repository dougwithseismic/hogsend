import { NextResponse } from "next/server";
import {
  forwardReferralVisited,
  referralVisitedConfigured,
} from "@/lib/ingest";

/**
 * POST /api/referral-visited — forwards an anonymous referral visit to the
 * dogfood's `referral-visited` webhook source when a visitor lands on /hey (or
 * /hey/<name>) with a `?ref` token. The ref is the referrer's opaque Hogsend
 * contact key, printed into the referral-ask email's `/hey/<name>?ref=<key>`
 * link. The webhook source stamps the (anonymous) visitor's contact with who
 * sent them so the eventual conversion (Discord /link) attributes back.
 *
 * It goes to the webhook source, NOT `/v1/events`: that route requires an email
 * or userId, and a page-view visitor has neither. The webhook source ingests
 * the `anonymousId`-only event directly.
 *
 * PRIVACY: the friend's display NAME from the URL is NEVER received here (the
 * client component forwards only `ref` + `anonymousId`) and never sent on. We
 * also do NOT pass the ref as an identity — it rides as a contact property; the
 * visitor's PostHog distinct_id is the only identity arm (anonymous).
 */

const MAX_REF_LENGTH = 200;

/** Bound + trim an opaque ref token; reject empty/over-long values. */
function sanitizeRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_REF_LENGTH) return null;
  return trimmed;
}

/** Bound + trim the PostHog distinct_id; drop anything implausible. */
function sanitizeAnonymousId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_REF_LENGTH) return undefined;
  return trimmed;
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!referralVisitedConfigured()) {
    return NextResponse.json(
      { error: "capture not configured" },
      { status: 503 },
    );
  }

  let ref: string | null;
  let anonymousId: string | undefined;
  try {
    const body = (await request.json()) as {
      ref?: unknown;
      anonymousId?: unknown;
    };
    ref = sanitizeRef(body?.ref);
    anonymousId = sanitizeAnonymousId(body?.anonymousId);
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  if (!ref) {
    return NextResponse.json({ error: "invalid ref" }, { status: 400 });
  }
  // No browser id → nothing to key the anonymous visit on. Skip quietly (the
  // visitor likely has PostHog blocked); not an error worth surfacing.
  if (!anonymousId) {
    return NextResponse.json(
      { ok: true, skipped: "no-anonymous-id" },
      { status: 202 },
    );
  }

  // Day-stamped idempotency: a reload (or back/forward to the same ref'd URL)
  // the same day dedupes; a later-day revisit still records. The latch in the
  // client ping covers a single mount; this covers reloads.
  const day = new Date().toISOString().slice(0, 10);

  const ok = await forwardReferralVisited(
    { ref, anonymousId },
    `referral-visited-${day}-${ref}`,
  );

  if (!ok) {
    return NextResponse.json({ error: "upstream failed" }, { status: 502 });
  }
  return NextResponse.json({ ok: true }, { status: 202 });
}
