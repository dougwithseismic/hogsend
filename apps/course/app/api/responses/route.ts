import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { response } from "@/lib/db/schema";
import {
  emitMediaCompleted,
  emitNoteSaved,
  emitProfileAnswered,
  emitQuizCompleted,
} from "@/lib/events";
import { PROFILE_FIELDS, PROFILE_LIMITS } from "@/lib/profile";
import { source } from "@/lib/source";

/**
 * Saves a reader's answer to an interactive lesson block (profile check-in,
 * quiz result, plan checklist) and hydrates it back on revisit. Session-guarded
 * both ways. The block KEY is always built server-side from the validated kind
 * + id, so a client can never write an arbitrary key; profile ids must exist in
 * PROFILE_FIELDS, so content can't invent contact properties either. Profile
 * answers and quiz scores are forwarded to the Hogsend ingest (fire-and-forget
 * semantics — an ingest failure never fails the save).
 */

type Saved = { key: string; kind: string; value: unknown };

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/i;
/** Media ids are YouTube video ids / podcast slugs — underscores allowed. */
const MEDIA_ID_PATTERN = /^[a-z0-9_-]{1,64}$/i;

function cleanStrings(
  input: unknown,
  maxItems: number,
  maxLength: number,
): string[] | null {
  if (!Array.isArray(input)) return null;
  if (input.length > maxItems) return null;
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") return null;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > maxLength) return null;
    out.push(trimmed);
  }
  return out;
}

function parseBody(body: unknown): Saved | { error: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "bad_request" };
  }
  const b = body as Record<string, unknown>;
  const kind = typeof b.kind === "string" ? b.kind : "";
  const id = typeof b.id === "string" ? b.id : "";
  const value =
    typeof b.value === "object" && b.value !== null
      ? (b.value as Record<string, unknown>)
      : null;
  if (!value) return { error: "bad_request" };

  // Optional display context (the question/prompt/title as authored in the
  // lesson) rides along in `value` so the workbook page can show each answer
  // with the words it was asked in, without re-parsing MDX.
  const context = (field: string, max: number) => {
    const v = value[field];
    return typeof v === "string" && v.trim()
      ? { [field]: v.trim().slice(0, max) }
      : {};
  };

  if (kind === "profile") {
    if (!PROFILE_FIELDS[id]) return { error: "unknown_field" };
    const choices =
      cleanStrings(
        value.choices ?? [],
        PROFILE_LIMITS.maxChoices,
        PROFILE_LIMITS.maxChoiceLength,
      ) ?? null;
    const note =
      typeof value.note === "string"
        ? value.note.trim().slice(0, PROFILE_LIMITS.maxNoteLength)
        : "";
    if (!choices || (choices.length === 0 && !note)) {
      return { error: "bad_request" };
    }
    return {
      key: `profile:${id}`,
      kind,
      value: {
        choices,
        ...(note ? { note } : {}),
        ...context("question", 300),
      },
    };
  }

  if (kind === "note") {
    if (!ID_PATTERN.test(id)) return { error: "bad_request" };
    const text =
      typeof value.text === "string" ? value.text.trim().slice(0, 2000) : "";
    if (!text) return { error: "bad_request" };
    return {
      key: `note:${id}`,
      kind,
      value: { text, ...context("prompt", 300) },
    };
  }

  if (kind === "quiz") {
    const score = value.score;
    const total = value.total;
    if (
      typeof score !== "number" ||
      typeof total !== "number" ||
      !Number.isInteger(score) ||
      !Number.isInteger(total) ||
      total < 1 ||
      total > 50 ||
      score < 0 ||
      score > total
    ) {
      return { error: "bad_request" };
    }
    return { key: "", kind, value: { score, total } }; // key built from lesson below
  }

  if (kind === "media") {
    if (!MEDIA_ID_PATTERN.test(id)) return { error: "bad_request" };
    const media = value.media === "podcast" ? "podcast" : "video";
    return {
      key: `media:${id}`,
      kind,
      value: { done: value.done === true, media, ...context("title", 200) },
    };
  }

  if (kind === "checklist") {
    if (!ID_PATTERN.test(id)) return { error: "bad_request" };
    const checked = cleanStrings(value.checked ?? [], 40, 160);
    if (!checked) return { error: "bad_request" };
    return {
      key: `checklist:${id}`,
      kind,
      value: { checked, ...context("title", 160) },
    };
  }

  return { error: "bad_request" };
}

export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const raw = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const parsed = parseBody(raw);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  // Lesson context: required (and validated against the content source) for a
  // quiz — it forms the key; optional context metadata for the other kinds.
  const course = typeof raw?.course === "string" ? raw.course : "";
  const lesson = typeof raw?.lesson === "string" ? raw.lesson : "";
  const page = course && lesson ? source.getPage([course, lesson]) : undefined;
  if (parsed.kind === "quiz") {
    if (!page)
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    parsed.key = `quiz:${course}/${lesson}`;
  }

  const now = new Date();
  await db
    .insert(response)
    .values({
      id: randomUUID(),
      userId: session.user.id,
      key: parsed.key,
      kind: parsed.kind,
      value: parsed.value,
      courseSlug: page ? course : null,
      lessonSlug: page ? lesson : null,
    })
    .onConflictDoUpdate({
      target: [response.userId, response.key],
      set: {
        value: parsed.value,
        ...(page ? { courseSlug: course, lessonSlug: lesson } : {}),
        updatedAt: now,
      },
    });

  const user = {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
  };
  if (parsed.kind === "profile") {
    const id = (raw?.id as string) ?? "";
    const v = parsed.value as { choices: string[]; note?: string };
    await emitProfileAnswered(user, {
      field: id,
      contactProperty: PROFILE_FIELDS[id].contactProperty,
      value: v.choices.join(", ") || v.note || "",
      note: v.note,
      course: page ? course : undefined,
      lesson: page ? lesson : undefined,
    });
  } else if (parsed.kind === "quiz") {
    const v = parsed.value as { score: number; total: number };
    await emitQuizCompleted(user, course, lesson, v.score, v.total);
  } else if (parsed.kind === "note") {
    const v = parsed.value as { text: string };
    await emitNoteSaved(user, {
      field: (raw?.id as string) ?? "",
      preview: v.text.slice(0, 300),
      course: page ? course : undefined,
      lesson: page ? lesson : undefined,
    });
  } else if (parsed.kind === "media") {
    const v = parsed.value as { done: boolean; media: string; title?: string };
    if (v.done) {
      await emitMediaCompleted(user, {
        id: (raw?.id as string) ?? "",
        media: v.media,
        title: v.title,
        course: page ? course : undefined,
        lesson: page ? lesson : undefined,
      });
    }
  }

  return NextResponse.json({ ok: true });
}

/** Hydrate one saved answer: GET /api/responses?key=profile:role → { value }. */
export async function GET(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const key = new URL(req.url).searchParams.get("key") ?? "";
  if (!key || key.length > 200) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const rows = await db
    .select({ value: response.value })
    .from(response)
    .where(and(eq(response.userId, session.user.id), eq(response.key, key)))
    .limit(1);
  return NextResponse.json({ value: rows[0]?.value ?? null });
}
