"use client";

import { createContext, type ReactNode, useContext } from "react";

/**
 * Which lesson the interactive blocks (Quiz/CheckIn/Checklist) are rendering
 * inside. Provided once by the lesson page around the MDX body, so blocks are
 * authored with zero course/lesson props. Null outside a lesson — blocks then
 * degrade gracefully (no persistence).
 */

export type LessonRef = { course: string; lesson: string };

const LessonContext = createContext<LessonRef | null>(null);

export function LessonProvider({
  course,
  lesson,
  children,
}: LessonRef & { children: ReactNode }) {
  return (
    <LessonContext.Provider value={{ course, lesson }}>
      {children}
    </LessonContext.Provider>
  );
}

export function useLesson(): LessonRef | null {
  return useContext(LessonContext);
}
