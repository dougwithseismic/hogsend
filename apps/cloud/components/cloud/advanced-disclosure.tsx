import { ChevronRight } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { Card } from "@/components/ds/card";

/**
 * A collapsed panel for material that answers a question nobody has in their
 * first five minutes.
 *
 * Native `<details>` on purpose: this is a server component with no state to
 * hydrate, the browser owns the open/closed toggle, and the content stays in
 * the DOM — so a customer sent here by support can still find a value with
 * ctrl-F before they have opened anything.
 */
export function AdvancedDisclosure({
  summary,
  children,
}: {
  /** What is inside, as a noun phrase — e.g. "Advanced details". */
  summary: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <Card className="p-0">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-6 py-4 text-sm text-white/60 transition-colors hover:text-white [&::-webkit-details-marker]:hidden">
          <ChevronRight
            aria-hidden
            className="size-3.5 transition-transform group-open:rotate-90"
            strokeWidth={2}
          />
          {summary}
        </summary>
        {children}
      </details>
    </Card>
  );
}
