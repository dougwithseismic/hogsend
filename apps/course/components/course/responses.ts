"use client";

import type { LessonRef } from "@/components/course/lesson-context";

/** Client fetch helpers for the /api/responses block-persistence API. */

export async function getResponse<T>(key: string): Promise<T | null> {
  try {
    const res = await fetch(`/api/responses?key=${encodeURIComponent(key)}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { value: T | null };
    return body.value ?? null;
  } catch {
    return null;
  }
}

export async function saveResponse(
  kind: "profile" | "quiz" | "checklist",
  id: string,
  value: unknown,
  lesson: LessonRef | null,
): Promise<boolean> {
  try {
    const res = await fetch("/api/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind,
        id,
        value,
        ...(lesson ? { course: lesson.course, lesson: lesson.lesson } : {}),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
