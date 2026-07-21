import { type HighlightOptions, highlight } from "fumadocs-core/highlight";
import { cn } from "@/lib/cn";

type ShikiTransformer = NonNullable<HighlightOptions["transformers"]>[number];

type CodeHighlightProps = {
  code: string;
  lang: string;
  className?: string;
  /** Extra Shiki transformers — e.g. the scaffold explorer's glossary marker. */
  transformers?: ShikiTransformer[];
};

/**
 * Server-side Shiki highlighting (reusing the `.shiki` CSS variables that
 * fumadocs-ui's preset already wires up). The `pre` background is forced
 * transparent so the code blends into our dark cards, and we apply our mono
 * code typography. Async RSC — no hooks, no client JS.
 */
export async function CodeHighlight({
  code,
  lang,
  className: propClassName,
  transformers,
}: CodeHighlightProps) {
  return highlight(code, {
    lang,
    transformers,
    components: {
      pre: ({ className, style, ...props }) => (
        <pre
          {...props}
          style={{ ...style, backgroundColor: "transparent" }}
          className={cn(
            className,
            "overflow-x-auto font-mono text-[13px] leading-relaxed",
            propClassName,
          )}
        />
      ),
    },
  });
}
