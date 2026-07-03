import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { Calculator } from "@/components/course/calculator";
import { CheckIn } from "@/components/course/check-in";
import { Checklist } from "@/components/course/checklist";
import { Figure } from "@/components/course/figure";
import { Flashcards } from "@/components/course/flashcards";
import { PodcastLink } from "@/components/course/podcast-link";
import { Quiz } from "@/components/course/quiz";
import { VideoEmbed } from "@/components/course/video-embed";
import { VideoTranscript } from "@/components/course/video-transcript";
import { WorkbookPrompt } from "@/components/course/workbook-prompt";

/** MDX component map for lesson rendering: Fumadocs defaults plus the
 *  interactive course blocks (quiz, profiling check-in, plan checklist,
 *  flashcard deck, calculator, click-to-load video, podcast recommendation).
 *  The blocks locate their lesson via LessonProvider. */
export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Calculator,
    CheckIn,
    Checklist,
    Figure,
    Flashcards,
    PodcastLink,
    Quiz,
    VideoEmbed,
    VideoTranscript,
    WorkbookPrompt,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
