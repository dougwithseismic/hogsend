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

/**
 * A progressive-profiling answer from a lesson `<CheckIn>` block. Writes the
 * answer onto the contact as `contactProperty` (so journeys/segments can read
 * it) and fires course.profile_answered for the event stream. Re-answering
 * fires again with the new value — latest write wins on the contact, and the
 * per-submit idempotency key only dedupes upstream retries of THIS submit.
 */
export async function emitProfileAnswered(
  user: AuthUser,
  input: {
    field: string;
    contactProperty: string;
    value: string;
    note?: string;
    course?: string;
    lesson?: string;
  },
): Promise<void> {
  if (!ingestConfigured()) return;
  await forwardToIngest(
    {
      name: "course.profile_answered",
      email: user.email,
      contactProperties: {
        courseUserId: user.id,
        [input.contactProperty]: input.value,
      },
      eventProperties: {
        source: SOURCE,
        field: input.field,
        value: input.value,
        ...(input.note ? { note: input.note } : {}),
        ...(input.course ? { course: input.course } : {}),
        ...(input.lesson ? { lesson: input.lesson } : {}),
      },
    },
    `course-profile-${user.id}-${input.field}-${Date.now()}`,
  );
}

/**
 * A workbook note saved from a lesson `<WorkbookPrompt>` (activation sentence,
 * tracking-plan draft, hypotheses, …). The full text lives in the course DB;
 * only a capped preview rides on the event stream.
 */
export async function emitNoteSaved(
  user: AuthUser,
  input: {
    field: string;
    preview: string;
    course?: string;
    lesson?: string;
  },
): Promise<void> {
  if (!ingestConfigured()) return;
  await forwardToIngest(
    {
      name: "course.note_saved",
      email: user.email,
      contactProperties: { courseUserId: user.id },
      eventProperties: {
        source: SOURCE,
        field: input.field,
        preview: input.preview,
        ...(input.course ? { course: input.course } : {}),
        ...(input.lesson ? { lesson: input.lesson } : {}),
      },
    },
    `course-note-${user.id}-${input.field}-${Date.now()}`,
  );
}

/**
 * A media block (lesson video / podcast) checked off as watched/listened.
 * Fired only on done=true — unchecking updates the row without an event.
 */
export async function emitMediaCompleted(
  user: AuthUser,
  input: {
    id: string;
    media: string;
    title?: string;
    course?: string;
    lesson?: string;
  },
): Promise<void> {
  if (!ingestConfigured()) return;
  await forwardToIngest(
    {
      name: "course.media_completed",
      email: user.email,
      contactProperties: { courseUserId: user.id },
      eventProperties: {
        source: SOURCE,
        mediaId: input.id,
        media: input.media,
        ...(input.title ? { title: input.title } : {}),
        ...(input.course ? { course: input.course } : {}),
        ...(input.lesson ? { lesson: input.lesson } : {}),
      },
    },
    `course-media-${user.id}-${input.id}-${Date.now()}`,
  );
}

/** An end-of-lesson quiz submission (score out of total, both integers). */
export async function emitQuizCompleted(
  user: AuthUser,
  course: string,
  lesson: string,
  score: number,
  total: number,
): Promise<void> {
  if (!ingestConfigured()) return;
  await forwardToIngest(
    {
      name: "course.quiz_completed",
      email: user.email,
      contactProperties: { courseUserId: user.id },
      eventProperties: {
        source: SOURCE,
        course,
        lesson,
        score,
        total,
        pct: total > 0 ? Math.round((score / total) * 100) : 0,
      },
    },
    `course-quiz-${user.id}-${course}-${lesson}-${Date.now()}`,
  );
}

/**
 * A gift checkout completed: the BUYER's event, carrying the minted code so
 * the lifecycle side can send their receipt/confirmation.
 */
export async function emitGiftPurchased(
  user: AuthUser,
  input: {
    courseSlug: string;
    courseTitle: string;
    code: string;
    recipientEmail?: string | null;
    amount?: number | null;
    currency?: string | null;
  },
): Promise<void> {
  if (!ingestConfigured()) return;
  await forwardToIngest(
    {
      name: "course.gift_purchased",
      email: user.email,
      contactProperties: { courseUserId: user.id, ...firstName(user.name) },
      eventProperties: {
        source: SOURCE,
        course: input.courseSlug,
        courseTitle: input.courseTitle,
        code: input.code,
        ...(input.recipientEmail
          ? { recipientEmail: input.recipientEmail }
          : {}),
        ...(typeof input.amount === "number" ? { amount: input.amount } : {}),
        ...(input.currency ? { currency: input.currency } : {}),
      },
    },
    `course-gift-purchased-${user.id}-${input.code}`,
  );
}

/**
 * The RECIPIENT's side of a gift (only when the buyer gave us their email):
 * identity is the recipient's email — this mints/updates their contact and
 * triggers the "you've been gifted" journey.
 */
export async function emitGifted(
  recipientEmail: string,
  input: {
    courseSlug: string;
    courseTitle: string;
    code: string;
    buyerName?: string | null;
  },
): Promise<void> {
  if (!ingestConfigured()) return;
  await forwardToIngest(
    {
      name: "course.gifted",
      email: recipientEmail,
      eventProperties: {
        source: SOURCE,
        course: input.courseSlug,
        courseTitle: input.courseTitle,
        code: input.code,
        ...(input.buyerName ? { buyerName: input.buyerName } : {}),
      },
    },
    `course-gifted-${recipientEmail}-${input.code}`,
  );
}

/**
 * The buyer's notification event when their gift code gets redeemed — carries
 * WHO claimed it (name + email of the redeeming account, plus the address the
 * gift was originally sent to) so the email can say so.
 */
export async function emitGiftRedeemed(
  buyer: AuthUser,
  input: {
    courseSlug: string;
    courseTitle: string;
    redeemerName?: string | null;
    redeemerEmail?: string | null;
    recipientEmail?: string | null;
  },
): Promise<void> {
  if (!ingestConfigured()) return;
  await forwardToIngest(
    {
      name: "course.gift_redeemed",
      email: buyer.email,
      contactProperties: { courseUserId: buyer.id },
      eventProperties: {
        source: SOURCE,
        course: input.courseSlug,
        courseTitle: input.courseTitle,
        ...(input.redeemerName ? { redeemerName: input.redeemerName } : {}),
        ...(input.redeemerEmail ? { redeemerEmail: input.redeemerEmail } : {}),
        ...(input.recipientEmail
          ? { recipientEmail: input.recipientEmail }
          : {}),
      },
    },
    `course-gift-redeemed-${buyer.id}-${input.courseSlug}-${Date.now()}`,
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
