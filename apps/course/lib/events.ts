import { forwardToIngest, ingestConfigured } from "@/lib/ingest";

/**
 * course.* lifecycle events forwarded to the dogfood engine's /v1/ingest.
 * Phase 2 only FIRES these; Phase 4 wires the consuming journeys.
 *
 * CRITICAL identity rule: identify by EMAIL only. NEVER pass the Better Auth user
 * id as the ingest top-level `userId` — that arm is the Hogsend external_id
 * contact key, and a Better Auth id there mints a phantom external_id twin (the
 * documented identity-resolution lockout). The auth id rides as
 * `contactProperties.courseUserId`.
 */

type AuthUser = { id: string; email: string; name?: string | null };

const SOURCE = "course-site";

function firstName(name?: string | null): Record<string, string> {
  const trimmed = name?.trim();
  return trimmed ? { firstName: trimmed.split(/\s+/)[0] } : {};
}

export async function emitSignedUp(user: AuthUser): Promise<void> {
  if (!ingestConfigured()) return;
  await forwardToIngest(
    {
      name: "course.signed_up",
      email: user.email,
      contactProperties: { courseUserId: user.id, ...firstName(user.name) },
      eventProperties: { source: SOURCE },
    },
    `course-signed-up-${user.id}`,
  );
}

export async function emitEnrolled(
  user: AuthUser,
  courseSlug: string,
  courseTitle: string,
): Promise<void> {
  if (!ingestConfigured()) return;
  await forwardToIngest(
    {
      name: "course.enrolled",
      email: user.email,
      contactProperties: { courseUserId: user.id },
      eventProperties: { source: SOURCE, course: courseSlug, courseTitle },
    },
    `course-enrolled-${user.id}-${courseSlug}`,
  );
}

export async function emitLessonCompleted(
  user: AuthUser,
  courseSlug: string,
  lessonSlug: string,
  lessonTitle: string,
): Promise<void> {
  if (!ingestConfigured()) return;
  await forwardToIngest(
    {
      name: "course.lesson_completed",
      email: user.email,
      contactProperties: { courseUserId: user.id },
      eventProperties: {
        source: SOURCE,
        course: courseSlug,
        lesson: lessonSlug,
        lessonTitle,
      },
    },
    `course-lesson-completed-${user.id}-${courseSlug}-${lessonSlug}`,
  );
}

export async function emitCompleted(
  user: AuthUser,
  courseSlug: string,
  courseTitle: string,
): Promise<void> {
  if (!ingestConfigured()) return;
  await forwardToIngest(
    {
      name: "course.completed",
      email: user.email,
      contactProperties: { courseUserId: user.id },
      eventProperties: { source: SOURCE, course: courseSlug, courseTitle },
    },
    `course-completed-${user.id}-${courseSlug}`,
  );
}

export async function emitPurchased(
  user: AuthUser,
  courseSlug: string,
  courseTitle: string,
  amount?: number | null,
  currency?: string | null,
): Promise<void> {
  if (!ingestConfigured()) return;
  await forwardToIngest(
    {
      name: "course.purchased",
      email: user.email,
      contactProperties: { courseUserId: user.id },
      eventProperties: {
        source: SOURCE,
        course: courseSlug,
        courseTitle,
        ...(typeof amount === "number" ? { amount } : {}),
        ...(currency ? { currency } : {}),
      },
    },
    `course-purchased-${user.id}-${courseSlug}`,
  );
}

export async function emitAccountDeleted(user: AuthUser): Promise<void> {
  if (!ingestConfigured()) return;
  await forwardToIngest(
    {
      name: "course.account_deleted",
      email: user.email,
      contactProperties: { courseUserId: user.id },
      eventProperties: { source: SOURCE },
    },
    `course-account-deleted-${user.id}`,
  );
}
