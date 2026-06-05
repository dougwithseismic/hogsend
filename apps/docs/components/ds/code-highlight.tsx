import { highlight } from "fumadocs-core/highlight";
import { cn } from "@/lib/cn";

type CodeHighlightProps = {
  code: string;
  lang: string;
  className?: string;
};

/**
 * Server-side Shiki highlighting (reusing the `.shiki` CSS variables that
 * fumadocs-ui's preset already wires up). The highlighted `pre` is wrapped in a
 * dark inset card (`bg-ink`, `rounded-2xl`) so the code reads as a dark inset on
 * the cream page — matching `CodeMock`/`MockupFrame` and Wispr Flow's dark code
 * cards. The `pre` background is forced transparent so the Shiki block blends
 * into the card, and we apply our mono code typography. Async RSC — no hooks,
 * no client JS.
 */
export async function CodeHighlight({
  code,
  lang,
  className: propClassName,
}: CodeHighlightProps) {
  return highlight(code, {
    lang,
    components: {
      pre: ({ className, style, ...props }) => (
        <pre
          {...props}
          style={{ ...style, backgroundColor: "transparent" }}
          className={cn(
            className,
            "overflow-x-auto rounded-2xl border border-ink/10 bg-ink px-5 py-5 font-mono text-[13.5px] leading-relaxed md:px-6 md:py-6 md:text-[14.5px]",
            propClassName,
          )}
        />
      ),
    },
  });
}
