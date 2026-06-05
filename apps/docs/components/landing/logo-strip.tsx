import { LogoMarquee } from "@/components/ds/marquee";
import { cn } from "@/lib/cn";

/**
 * Dark thin band sitting directly under the hero. A small "WORKS WITH" label on
 * the left, then an auto-scrolling marquee of the stack wordmarks. Pure text
 * wordmarks — no real logo assets — styled in the display face with mono tags.
 *
 * Server component: it composes the client-free `LogoMarquee` (CSS keyframe)
 * and renders styled wordmarks as its items.
 */

const STACK = [
  "PostHog",
  "Resend",
  "Railway",
  "Docker",
  "Hatchet",
  "TypeScript",
  "Stripe",
] as const;

function Wordmark({ name }: { name: string }) {
  return (
    <span className="whitespace-nowrap font-display text-lg text-white/70 tracking-tight md:text-xl">
      {name}
    </span>
  );
}

export function LogoStrip({ className }: { className?: string }) {
  const items = STACK.map((name) => <Wordmark key={name} name={name} />);

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
