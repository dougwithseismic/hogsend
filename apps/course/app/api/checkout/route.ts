import { headers } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ALL_ACCESS_SLUG, priceIdForCourse } from "@/lib/courses";
import { env } from "@/lib/env";
import { EMAIL_PATTERN } from "@/lib/ingest";
import { clampSeats } from "@/lib/licenses";
import { getStripe, paywallConfigured } from "@/lib/stripe";

export const runtime = "nodejs";

/**
 * POST /api/checkout — create a Stripe Checkout Session for a one-time course
 * purchase and 303-redirect the browser to Stripe's hosted page. Driven by the
 * <Paywall> form (course + next as fields). No client JS, no card handling.
 *
 * Gift mode (`gift=1`, optional `recipientEmail`): the buyer pays full price
 * but gets NO entitlement — the webhook mints a single-use 100%-off code
 * instead (see lib/gifts.ts) and the lifecycle emails deliver it.
 *
 * Team mode (`team=1`, `seats=N`, clamped 2–25): the buyer pays N × price in
 * one session and gets NO entitlement — the webhook mints N single-use codes
 * (see lib/licenses.ts) and emails them to the buyer to distribute.
 */

/** Only allow same-site relative return paths (no open redirect). */
function safePath(next: string, fallback: string): string {
  return next.startsWith("/") && !next.startsWith("//") ? next : fallback;
}

export async function POST(req: NextRequest): Promise<Response> {
  const session = await auth.api.getSession({ headers: await headers() });

  const form = await req.formData();
  const course = String(form.get("course") ?? "");
  const isTeam = form.get("team") === "1";
  const seats = isTeam ? clampSeats(form.get("seats")) : 1;
  // Team wins over gift if a form somehow posts both — they're separate modes.
  const isGift = !isTeam && form.get("gift") === "1";
  const recipientRaw = String(form.get("recipientEmail") ?? "")
    .trim()
    .toLowerCase();
  const recipientEmail =
    isGift && EMAIL_PATTERN.test(recipientRaw) ? recipientRaw : "";
  // All-access isn't a page, so its return path defaults to the account page;
  // a course returns to its overview.
  const fallback = course === ALL_ACCESS_SLUG ? "/account" : `/${course}`;
  const next = safePath(String(form.get("next") ?? ""), fallback);
  // Build redirect URLs from the configured site URL, not the request Host
  // header — Stripe success/cancel must point at our own origin, untrusted-input-free.
  const base = env.BETTER_AUTH_URL.replace(/\/+$/, "");

  // Not signed in → bounce to sign-in, return here after. Carry the intent to
  // buy through auth as a `checkout` marker on the return path: the paywall
  // resumes the purchase automatically once they're back, instead of making
  // them click Buy a second time. Entitlement is still derived server-side on
  // the resumed POST — the marker only re-triggers the same form.
  if (!session) {
    const resumeNext = `${next}${next.includes("?") ? "&" : "?"}checkout=${encodeURIComponent(course)}`;
    return NextResponse.redirect(
      `${base}/sign-in?next=${encodeURIComponent(resumeNext)}`,
      303,
    );
  }

  const priceId = priceIdForCourse(course);
  // Paywall off / course not for sale → just send them to the lesson; the gate
  // decides access. Never 500 a misconfigured course into a dead end.
  if (!paywallConfigured() || !priceId) {
    return NextResponse.redirect(`${base}${next}`, 303);
  }

  const checkout = await getStripe().checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: priceId, quantity: seats }],
    client_reference_id: session.user.id,
    customer_email: session.user.email,
    metadata: {
      courseSlug: course,
      userId: session.user.id,
      ...(isTeam ? { team: "true", seats: String(seats) } : {}),
      ...(isGift ? { gift: "true" } : {}),
      ...(recipientEmail ? { recipientEmail } : {}),
    },
    // Discount codes (including single-use 100%-off gift/free copies) are
    // entered on Stripe's hosted page; a fully-discounted session still
    // completes and the webhook grants the entitlement unchanged. Team
    // sessions accept NO codes — a single-use 100%-off code must not zero an
    // N-seat purchase and mint N fresh codes for free.
    allow_promotion_codes: !isTeam,
    // Generate a proper invoice (PDF) per purchase so it shows in the account
    // billing section and the customer gets a receipt.
    invoice_creation: { enabled: true },
    // Non-gift buyers land on the /welcome tour (which re-validates `next`
    // itself); gift buyers return to the overview's GiftBanner unchanged, and
    // team buyers to the overview's team banner.
    // `paid=1` marks a completed purchase redirect so /welcome shows the
    // "unlocking" hint only to real buyers (not to anyone who lands with ?course).
    success_url: isTeam
      ? `${base}${next}?team=success`
      : isGift
        ? `${base}${next}?gift=success`
        : `${base}/welcome?course=${encodeURIComponent(course)}&next=${encodeURIComponent(next)}&paid=1`,
    cancel_url: `${base}${next}?${isTeam ? "team" : isGift ? "gift" : "purchase"}=cancelled`,
  });

  if (!checkout.url) {
    return NextResponse.json(
      { error: "could not create checkout session" },
      { status: 502 },
    );
  }
  return NextResponse.redirect(checkout.url, 303);
}
