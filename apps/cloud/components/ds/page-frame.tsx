import { cn } from "@/lib/cn";

type PageFrameProps = {
  className?: string;
};

/**
 * The crimzon signature: two full-page-height vertical hairlines (1px,
 * white/4) on the outer edges of the content frame, running from the top of
 * the page to the bottom, plus a faint noise overlay at ~2.5%.
 *
 * The frame is offset by the nav rail at md+ so the hairlines bracket the
 * content column, not the rail. Fixed, pointer-events-none, mounted once in
 * app/layout.tsx.
 */
export function PageFrame({ className }: PageFrameProps) {
  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none fixed inset-0 z-20", className)}
    >
      <div className="noise absolute inset-0" />
      <div className="h-full md:pl-rail">
        <div className="container-page relative h-full">
          <span className="absolute inset-y-0 left-0 w-px bg-white/[0.04]" />
          <span className="absolute inset-y-0 right-0 w-px bg-white/[0.04]" />
        </div>
      </div>
    </div>
  );
}
