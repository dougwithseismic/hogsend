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
 * code window (`bg-code`, `rounded-2xl`) — a fixed espresso surface that stays
 * DARK in BOTH light and dark themes, matching `CodeMock`/`MockupFrame`. The
 * `pre` background is forced transparent so the Shiki block blends into the
 * card, and we apply our mono code typography.
 *
 * We pin a single `theme: "github-dark"` (light-on-dark) rather than letting
 * fumadocs apply its dual github-light/github-dark default. Because the surface
 * never flips, the code must always render its light-text variant; the dual
 * default would emit dark (`--shiki-light`) text in the light theme, which would
 * be unreadable on the always-dark `#1f150f` window. Async RSC — no hooks,
 * no client JS.
 */
export async function CodeHighlight({
  code,
  lang,
  className: propClassName,
}: CodeHighlightProps) {
  return highlight(code, {
    lang,
    theme: "github-dark",
    components: {
      pre: ({ className, style, ...props }) => (
        <pre
          {...props}
          style={{ ...style, backgroundColor: "transparent" }}
          className={cn(
            className,
            "overflow-x-auto rounded-2xl border border-white/10 bg-code px-5 py-5 font-mono text-[13.5px] leading-relaxed md:px-6 md:py-6 md:text-[14.5px]",
            propClassName,
          )}
        />
      ),
    },
  });
}
