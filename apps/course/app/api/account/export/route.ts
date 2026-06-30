import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { listInvoices } from "@/lib/billing";
import { db } from "@/lib/db";
import { enrollment, lessonProgress, purchase, user } from "@/lib/db/schema";

export const runtime = "nodejs";

/**
 * GET /api/account/export — GDPR right-to-access / portability. Returns a JSON
 * file of everything we hold for the SIGNED-IN user (derived from the session,
 * never a query param): profile, enrollments, lesson progress, purchases, and
 * downloadable invoice metadata. Anonymous → 401.
 */
export async function GET(): Promise<Response> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const uid = session.user.id;

  const [profile, enrollments, progress, purchases, invoices] =
    await Promise.all([
      db.select().from(user).where(eq(user.id, uid)),
      db.select().from(enrollment).where(eq(enrollment.userId, uid)),
      db.select().from(lessonProgress).where(eq(lessonProgress.userId, uid)),
      db.select().from(purchase).where(eq(purchase.userId, uid)),
      listInvoices(uid),
    ]);

  const payload = {
    exportedAt: new Date().toISOString(),
    profile: profile[0] ?? null,
    enrollments,
    lessonProgress: progress,
    purchases,
    invoices,
  };

  return new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-disposition": 'attachment; filename="hogsend-course-data.json"',
      "cache-control": "no-store",
    },
  });
}
