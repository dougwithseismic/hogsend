import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { recordLessonProgress } from "@/lib/gating";
import { source } from "@/lib/source";

/** Records a completed lesson for the signed-in user. Session-guarded; validates
 *  the lesson exists in the content source before writing. */
export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    course?: unknown;
    lesson?: unknown;
  } | null;
  const course = typeof body?.course === "string" ? body.course : null;
  const lesson = typeof body?.lesson === "string" ? body.lesson : null;
  if (!course || !lesson) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // `lesson` is the full sub-path after the course (e.g.
  // `01-what-is-posthog/why-measure`); getPage wants it as slug segments.
  const page = source.getPage([course, ...lesson.split("/")]);
  if (!page) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await recordLessonProgress(
    { id: session.user.id, email: session.user.email, name: session.user.name },
    course,
    lesson,
    page.data.title,
  );
  return NextResponse.json({ ok: true });
}
