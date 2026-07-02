import { and, eq, inArray } from "drizzle-orm";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { response } from "@/lib/db/schema";
import {
  courseWorkbookLessons,
  dedupeByKey,
  type SavedValue,
  workbookProgress,
} from "@/lib/workbook";

/**
 * Workbook progress summary for one course: GET /api/workbook?course=slug →
 * { done, total }. Session-guarded; feeds the reader-sidebar progress strip.
 */
export async function GET(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const course = new URL(req.url).searchParams.get("course") ?? "";
  const items = dedupeByKey(
    courseWorkbookLessons(course).flatMap((l) => l.items),
  );
  if (items.length === 0) {
    return NextResponse.json({ done: 0, total: 0 });
  }

  const rows = await db
    .select({ key: response.key, value: response.value })
    .from(response)
    .where(
      and(
        eq(response.userId, session.user.id),
        inArray(
          response.key,
          items.map((i) => i.key),
        ),
      ),
    );
  const values: Record<string, SavedValue> = Object.fromEntries(
    rows.map((row) => [row.key, row.value as SavedValue]),
  );
  return NextResponse.json(workbookProgress(items, values));
}
