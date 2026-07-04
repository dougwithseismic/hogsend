import { CALCULATORS } from "./calculators";
import { FLAGSHIP_SLUG } from "./courses";
import manifestJson from "./workbook-manifest.generated.json";

/**
 * Canonical content facts for the flagship course, derived from the generated
 * workbook manifest at build time so marketing surfaces (course landing,
 * catalog, welcome, pricing) can never drift from the actual content again —
 * the catalog once said "11 chapters" for a 15-chapter course.
 *
 * Server-side only: the manifest JSON is large; don't import this from client
 * components (lib/courses.ts stays the client-safe home for course metadata).
 */

type ManifestRow = { kind: string; media?: string; itemCount?: number };

const rows: ManifestRow[] = Object.values(
  (manifestJson as Record<string, Record<string, ManifestRow[]>>)[
    FLAGSHIP_SLUG
  ] ?? {},
).flat();

const count = (kind: string): number =>
  rows.filter((r) => r.kind === kind).length;
const itemSum = (kind: string): number =>
  rows
    .filter((r) => r.kind === kind)
    .reduce((sum, r) => sum + (r.itemCount ?? 0), 0);

export const FLAGSHIP_CONTENT_FACTS = {
  /** Every interactive item that persists to the reader's workbook. */
  workbookItems: rows.length,
  quizzes: count("quiz"),
  quizQuestions: itemSum("quiz"),
  flashcardDecks: count("flashcards"),
  flashcards: itemSum("flashcards"),
  /** Profiling check-ins (workbook kind "profile"). */
  checkIns: count("profile"),
  /** Writing prompts (workbook kind "note"). */
  writingPrompts: count("note"),
  checklists: count("checklist"),
  videos: rows.filter((r) => r.kind === "media" && r.media === "video").length,
  podcasts: rows.filter((r) => r.kind === "media" && r.media === "podcast")
    .length,
  readingLists: count("reading"),
  /** Calculator instances in the content vs distinct presets. */
  calculators: count("calc"),
  calculatorPresets: Object.keys(CALCULATORS).length,
  dayPlan: "30/60/90/180",
  /**
   * The staged plan the plan chapter assembles: day-0 commitments plus the
   * 30/60/90/180 stage checklists (5+8+8+8+8). Not derivable from the manifest
   * (checklist rows don't carry itemCount), so it stays literal — the whole
   * chapter carries 48 checklist items including weekly review + zero-to-one.
   */
  planItems: 37,
} as const;
