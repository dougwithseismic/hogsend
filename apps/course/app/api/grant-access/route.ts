import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { ALL_ACCESS_SLUG } from "@/lib/courses";
import { db } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { recordPurchase } from "@/lib/entitlements";

export const runtime = "nodejs";

/**
 * POST /api/grant-access — grant course all-access to someone who bought a
 * services package (Setup week / Done-for-you). Server-to-server only: the
 * dogfood `service-course-access` journey calls it with the shared
 * `x-grant-access-secret` header after `service.purchased`; never the browser.
 * Fail-closed 503 when `COURSE_GRANT_SECRET` is unset.
 *
 * Trusted for WHO (the buyer's email — already verified by the signed-in
 * services checkout) but grants only the all-access bundle: resolve email →
 * account → `recordPurchase(ALL_ACCESS_SLUG)`. Idempotent (the user×course +
 * checkout-session unique indexes + ON CONFLICT DO NOTHING), so a journey
 * re-fire or retried call is a no-op. Access is keyed by account, so an email
 * with no course account yet returns 404 `no_account` (the caller emails a
 * claim link; re-fire once they've signed up).
 */

/** Constant-time compare (length leak only — lengths differ → early false). */
function secretsMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest): Promise<Response> {
  const expected = process.env.COURSE_GRANT_SECRET ?? "";
  if (!expected) {
    return new Response("grant-access not configured", { status: 503 });
  }
  const secret = req.headers.get("x-grant-access-secret");
  if (!secret || !secretsMatch(secret, expected)) {
    return new Response("unauthorized", { status: 401 });
  }

  let body: { email?: unknown };
  try {
    body = await req.json();
  } catch {
    return new Response("invalid json", { status: 400 });
  }
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!email) return new Response("email required", { status: 400 });

  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(sql`lower(${user.email}) = ${email.toLowerCase()}`)
    .limit(1);
  const account = rows[0];
  if (!account) {
    // No course account for this email yet — access is keyed by account id, so
    // there's nothing to grant. The caller emails a "create your account to
    // claim it" note and can re-fire once they've signed up.
    return Response.json(
      { granted: false, reason: "no_account" },
      { status: 404 },
    );
  }

  // Deterministic synthetic session id → the checkout-session unique index also
  // dedupes (same buyer → same key), on top of the user×course index.
  const isNew = await recordPurchase({
    userId: account.id,
    courseSlug: ALL_ACCESS_SLUG,
    stripeCheckoutSessionId: `grant:all-access:${account.id}`,
  });

  return Response.json({ granted: true, alreadyHad: !isNew });
}
