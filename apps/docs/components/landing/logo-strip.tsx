import { type BrandKey, BrandLogo } from "@/components/ds/brand-logo";
import { LogoMarquee } from "@/components/ds/marquee";
import { cn } from "@/lib/cn";

/**
 * Dark thin band sitting directly under the hero. A small "WORKS WITH" label on
 * the left, then an auto-scrolling marquee of the stack marks. Renders real
 * masked brand SVGs (via `BrandLogo`) tinted to the surrounding white/opacity
 * treatment — no plain-text wordmarks.
 *
 * Server component: it composes the client-free `LogoMarquee` (CSS keyframe)
 * and renders the brand marks as its items.
 */

const STACK = [
  "posthog",
  "resend",
  "stripe",
  "railway",
  "typescript",
] as const satisfies readonly BrandKey[];

export function LogoStrip({ className }: { className?: string }) {
  const items = STACK.map((brand) => (
    <BrandLogo
      key={brand}
      brand={brand}
      height={24}
      className="text-white/70"
    />
  ));

  return (
    <section
      className={cn(
        "relative overflow-hidden border-white/[0.08] border-y bg-ink text-white",
        className,
      )}
    >
      <div className="container-page">
        <div className="flex flex-col gap-6 py-8 md:flex-row md:items-center md:gap-10 md:py-9">
          <span className="eyebrow shrink-0 text-white/40">Works with</span>

          <div className="relative min-w-0 flex-1">
            <LogoMarquee items={items} />
          </div>
        </div>
      </div>
    </section>
  );
}
