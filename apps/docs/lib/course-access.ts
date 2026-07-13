import { and, eq } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";

/**
 * Course entitlements for the portal, read DIRECTLY from the shared user
 * database — docs already points at the course's Postgres (that's what makes
 * the `*.hogsend.com` session portable), so no cross-service hop is needed.
 *
 * This is a minimal READ-ONLY mirror of the course app's `purchase` table
 * (apps/course/lib/db/schema.ts — the course owns the table + migrations);
 * only the three columns the access check needs are declared. Mirrors the
 * course's own `hasAccess`/`listOwnedSlugs` semantics: `status = "paid"` rows
 * count, and the `all-access` slug grants everything.
 */
const purchase = pgTable("purchase", {
  userId: text("user_id").notNull(),
  courseSlug: text("course_slug").notNull(),
  status: text("status").notNull(),
});

const ALL_ACCESS_SLUG = "all-access";

export type CourseAccess = {
  /** Holds the all-access bundle (every course + the workbook). */
  allAccess: boolean;
  /** Distinct paid SKUs (courses and/or the bundle). */
  ownedCount: number;
};

export async function getCourseAccess(userId: string): Promise<CourseAccess> {
  try {
    const rows = await db
      .select({ courseSlug: purchase.courseSlug })
      .from(purchase)
      .where(and(eq(purchase.userId, userId), eq(purchase.status, "paid")));
    const slugs = new Set(rows.map((r) => r.courseSlug));
    return { allAccess: slugs.has(ALL_ACCESS_SLUG), ownedCount: slugs.size };
  } catch {
    // Table missing (a docs instance pointed at a non-course DB) or transient
    // DB error — the portal shows the not-owned state rather than 500ing.
    return { allAccess: false, ownedCount: 0 };
  }
}
