import { GitBranch, MousePointerClick, RefreshCw, Send } from "lucide-react";
import { Reveal } from "@/components/ds/reveal";
import { cn } from "@/lib/cn";

/**
 * Pillars — the crimzon icon feature row: four equal columns separated by
 * vertical hairlines, each a thin-stroke icon, a 16px/500 title, and a short
 * white/60 body.
 */

type Pillar = {
  icon: React.ReactNode;
  title: string;
  description: string;
};

const ICON_SIZE = 20;

const PILLARS: Pillar[] = [
  {
    icon: <GitBranch size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Journeys as code",
    description:
      "Lifecycle logic is TypeScript in your repo — reviewed, type-checked, and versioned like the rest of your product.",
  },
  {
    icon: <Send size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Your provider, your reputation",
    description:
      "Sends go through your own Resend or Postmark account — or any provider behind the EmailProvider contract.",
  },
  {
    icon: <MousePointerClick size={ICON_SIZE} strokeWidth={1.5} />,
    title: "First-party tracking",
    description:
      "The engine rewrites links and tracks opens and clicks itself, whichever provider you plug in. The data lands in your own Postgres.",
  },
  {
    icon: <RefreshCw size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Durable execution",
    description:
      "Journeys run as Hatchet durable tasks — a seven-day wait survives deploys, restarts, and crashes.",
  },
];

export function Pillars({ className }: { className?: string }) {
  return (
    <section
      className={cn(
        "relative border-hairline-faint border-t text-white",
        className,
      )}
    >
      <div className="container-page py-14">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
          {PILLARS.map((pillar, index) => (
            <Reveal
              key={pillar.title}
              delay={(index % 4) * 0.08}
              className={cn(
                "px-0 py-8 sm:px-8 sm:py-2 lg:py-0",
                index > 0 && "border-hairline-faint border-t sm:border-t-0",
                index % 2 === 1 && "sm:border-hairline-faint sm:border-l",
                index > 0 && "lg:border-hairline-faint lg:border-l",
                index === 0 && "sm:pl-0",
                index === PILLARS.length - 1 && "lg:pr-0",
              )}
            >
              <span aria-hidden="true" className="block text-white">
                {pillar.icon}
              </span>
              <h3 className="mt-10 font-medium font-sans text-base text-white tracking-[-0.02em]">
                {pillar.title}
              </h3>
              <p className="mt-3 text-sm text-white/60 leading-[1.5]">
                {pillar.description}
              </p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
