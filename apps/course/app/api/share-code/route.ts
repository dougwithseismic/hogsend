import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { hasAccess } from "@/lib/entitlements";
import { mintShareCode, shareCodeConfigured } from "@/lib/share-codes";

export const runtime = "nodejs";

/**
 * POST /api/share-code — mint a single-use share discount code for an engaged
 * student. Server-to-server only: called by the lifecycle side (the dogfood
 * journey, a week after purchase) with the shared secret header; never from
 * the browser. Fail-closed 503 when unconfigured.
 *
 * The caller is trusted for WHO (the student's email) but not for
 * entitlement — ownership is re-checked here against the purchase table, so
 * a mis-fired journey can't mint discounts for non-owners.
 *
 * Idempotency note: the journey wraps this call in ctx.once + entryLimit
 * "once", so one code per student. A response lost in transit can orphan a
 * minted coupon; orphans are single-use, product-restricted, and expire.
 */
/** Constant-time compare (length leak only — lengths differ → early false). */
function secretsMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest): Promise<Response> {
  if (!shareCodeConfigured()) {
    return new Response("share codes not configured", { status: 503 });
  }
  const secret = req.headers.get("x-share-code-secret");
  if (!secret || !secretsMatch(secret, process.env.SHARE_CODE_SECRET ?? "")) {
    return new Response("unauthorized", { status: 401 });
  }

  let body: { email?: unknown; course?: unknown };
  try {
    body = await req.json();
  } catch {
    return new Response("invalid json", { status: 400 });
  }
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const courseSlug =
    typeof body.course === "string" && body.course.trim()
      ? body.course.trim()
      : "growth-with-posthog";
  if (!email) return new Response("email required", { status: 400 });

  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(sql`lower(${user.email}) = ${email.toLowerCase()}`)
    .limit(1);
  const student = rows[0];
  if (!student) return new Response("unknown student", { status: 404 });
  if (!(await hasAccess(student.id, courseSlug))) {
    return new Response("not an owner", { status: 403 });
  }

  const minted = await mintShareCode({
    shareUserId: student.id,
    courseSlug,
  });
  return Response.json(minted);
}
