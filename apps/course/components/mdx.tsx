import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { CheckIn } from "@/components/course/check-in";
import { Checklist } from "@/components/course/checklist";
import { Quiz } from "@/components/course/quiz";
import { VideoEmbed } from "@/components/course/video-embed";

/** MDX component map for lesson rendering: Fumadocs defaults plus the
 *  interactive course blocks (quiz, profiling check-in, plan checklist,
 *  click-to-load video). The blocks locate their lesson via LessonProvider. */
export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    CheckIn,
    Checklist,
    Quiz,
    VideoEmbed,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
