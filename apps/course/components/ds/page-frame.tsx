import { cn } from "@/lib/cn";

type PageFrameProps = {
  className?: string;
};

/**
 * The crimzon signature: two full-page-height vertical hairlines (1px,
 * white/4) sitting on the outer edges of the 1200px content frame, running
 * from the very top of the page to the very bottom — through nav, every
 * section, and the footer. A faint noise overlay rides along at ~2.5%.
 *
 * Fixed, pointer-events-none, mounted once in app/layout.tsx.
 */
export function PageFrame({ className }: PageFrameProps) {
  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none fixed inset-0 z-20", className)}
    >
      <div className="noise absolute inset-0" />
      <div className="container-page relative h-full">
        <span className="absolute inset-y-0 left-0 w-px bg-white/[0.04]" />
        <span className="absolute inset-y-0 right-0 w-px bg-white/[0.04]" />
      </div>
    </div>
  );
}
