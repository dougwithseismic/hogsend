import { headers } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { priceIdForCourse } from "@/lib/courses";
import { env } from "@/lib/env";
import { getStripe, paywallConfigured } from "@/lib/stripe";

export const runtime = "nodejs";

/**
 * POST /api/checkout — create a Stripe Checkout Session for a one-time course
 * purchase and 303-redirect the browser to Stripe's hosted page. Driven by the
 * <Paywall> form (course + next as fields). No client JS, no card handling.
 */

/** Only allow same-site relative return paths (no open redirect). */
function safePath(next: string, fallback: string): string {
  return next.startsWith("/") && !next.startsWith("//") ? next : fallback;
}

export async function POST(req: NextRequest): Promise<Response> {
  const session = await auth.api.getSession({ headers: await headers() });

  const form = await req.formData();
  const course = String(form.get("course") ?? "");
  const next = safePath(String(form.get("next") ?? ""), `/${course}`);
  // Build redirect URLs from the configured site URL, not the request Host
  // header — Stripe success/cancel must point at our own origin, untrusted-input-free.
  const base = env.BETTER_AUTH_URL.replace(/\/+$/, "");

  // Not signed in → bounce to sign-in, return here after.
  if (!session) {
    return NextResponse.redirect(
      `${base}/sign-in?next=${encodeURIComponent(next)}`,
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
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: session.user.id,
    customer_email: session.user.email,
    metadata: { courseSlug: course, userId: session.user.id },
    // Generate a proper invoice (PDF) per purchase so it shows in the account
    // billing section and the customer gets a receipt.
    invoice_creation: { enabled: true },
    success_url: `${base}${next}?purchase=success`,
    cancel_url: `${base}${next}?purchase=cancelled`,
  });

  if (!checkout.url) {
    return NextResponse.json(
      { error: "could not create checkout session" },
      { status: 502 },
    );
  }
  return NextResponse.redirect(checkout.url, 303);
}
