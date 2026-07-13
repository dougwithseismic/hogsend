import { headers } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { postToHogsendApi } from "@/lib/hogsend-api";
import { isCheckoutTier } from "@/lib/pricing";

export const runtime = "nodejs";

/**
 * POST /api/checkout — start a self-serve service purchase (Managed / Setup
 * week). This site holds NO Stripe secret: it verifies the visitor's session
 * (so the email is trusted), then forwards the tier + email to the Hono API's
 * `POST /checkout` over the shared `SERVICE_CHECKOUT_SECRET` bearer, and
 * 303-redirects the browser to the Stripe URL the API returns. The Stripe
 * session (and its `metadata.plan` for the funnel) is minted there, next to the
 * closing webhook. Driven by the <CheckoutButton> form — no client JS.
 *
 * Any misconfiguration or upstream failure falls back to the booking form so a
 * paid CTA never dead-ends.
 */

/** Only allow same-site relative return paths (no open redirect). */
function safePath(next: string, fallback: string): string {
  return next.startsWith("/") && !next.startsWith("//") ? next : fallback;
}

export async function POST(req: NextRequest): Promise<Response> {
  const session = await auth.api.getSession({ headers: await headers() });

  const form = await req.formData();
  const tier = String(form.get("tier") ?? "");
  const base = env.BETTER_AUTH_URL.replace(/\/+$/, "");
  const next = safePath(String(form.get("next") ?? ""), "/pricing");

  // Not a self-serve tier (self-host / done-for-you / unknown) → services page.
  if (!isCheckoutTier(tier)) {
    return NextResponse.redirect(`${base}/service`, 303);
  }

  // Not signed in → bounce to sign-in and return to the page they were on. The
  // shared *.hogsend.com session means a course login already counts.
  if (!session) {
    return NextResponse.redirect(
      `${base}/sign-in?next=${encodeURIComponent(next)}`,
      303,
    );
  }

  // Unconfigured env, 409 (tier not purchasable — price unset), API down, or
  // malformed reply → the booking form, never a dead end.
  const data = await postToHogsendApi<{ url?: unknown }>("/checkout", {
    tier,
    email: session.user.email,
    userId: session.user.id,
  });
  if (typeof data?.url !== "string") {
    return NextResponse.redirect(`${base}/service#enquire`, 303);
  }
  return NextResponse.redirect(data.url, 303);
}
