import "server-only";
import type { FlashCard } from "@/components/course/flashcards";
import type { QuizQuestion } from "@/components/course/quiz";
import contentJson from "./workbook-content.generated.json";

/**
 * Typed access to the SERVER-ONLY rich workbook content (see
 * scripts/generate-workbook-manifest.mjs): the flashcard decks, quiz question
 * pools, and calculator presets the workbook chapter pages re-render inline.
 * This is paid chapter content — the `server-only` import makes any client
 * bundle inclusion a build error, and pages must check entitlements before
 * passing it to client blocks (props serialize into the page's RSC payload).
 */

export type RichFlashcards = { title: string; cards: FlashCard[] };
export type RichQuiz = { title: string; questions: QuizQuestion[] };
export type RichCalc = { preset: string; title: string };
export type RichBlock = RichFlashcards | RichQuiz | RichCalc;

type WorkbookContent = Record<
  string,
  Record<string, Record<string, RichBlock>>
>;

const WORKBOOK_CONTENT = contentJson as WorkbookContent;

/** Rich block props for one lesson, keyed by item key (flashcards:…, quiz:…, calc:…). */
export function lessonRichContent(
  course: string,
  lesson: string,
): Record<string, RichBlock> {
  return WORKBOOK_CONTENT[course]?.[lesson] ?? {};
}
