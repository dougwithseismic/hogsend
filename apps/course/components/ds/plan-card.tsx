import { Check } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Card } from "./card";

/** Accent-check feature list used inside pricing/plan cards. */
function CheckList({ items }: { items: ReactNode[] }): JSX.Element {
  return (
    <ul className="mt-4 flex flex-col gap-3">
      {items.map((item, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: static, never-reordered list
          key={i}
          className="flex items-start gap-3 text-base text-white/80 leading-6"
        >
          <Check
            aria-hidden="true"
            className="mt-1 size-4 shrink-0 text-accent"
            strokeWidth={2}
          />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

type PlanCardProps = {
  name: string;
  badge?: ReactNode;
  price: string;
  priceSuffix: string;
  description: string;
  features: ReactNode[];
  cta: ReactNode;
  popular?: boolean;
};

/**
 * One pricing card: name row (chip on the popular tier), a huge numeral,
 * FEATURES label + check rows, and a bottom-pinned CTA above a hairline.
 * The popular tier gets the accent border and a warm glow from the bottom.
 * Shared by the pricing page and the course landing page.
 */
export function PlanCard({
  name,
  badge,
  price,
  priceSuffix,
  description,
  features,
  cta,
  popular = false,
}: PlanCardProps): JSX.Element {
  return (
    <Card
      className={cn(
        // Opaque fill so the card reads cleanly where it floats over a hero
        // glow (the base Card is near-transparent).
        "relative h-full overflow-hidden bg-[#0a0606] p-8",
        popular && "border-accent/40",
      )}
    >
      {popular ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(90% 55% at 50% 100%, rgba(246, 72, 56, 0.25), transparent 70%)",
          }}
        />
      ) : null}
      <div className="relative flex h-full flex-col">
        <div className="flex items-center justify-between gap-4">
          <span className="text-base text-white">{name}</span>
          {badge}
        </div>
        <div className="mt-6 flex items-baseline gap-1.5">
          <span className="font-display text-[56px] text-white leading-none tracking-[-0.02em]">
            {price}
          </span>
          <span className="text-base text-white/60">{priceSuffix}</span>
        </div>
        <p className="mt-4 text-base text-white/70 leading-6">{description}</p>
        <p className="eyebrow mt-8 text-white/50">Features</p>
        <CheckList items={features} />
        <div className="mt-8 flex flex-1 flex-col justify-end">
          <div className="border-white/[0.08] border-t pt-6">{cta}</div>
        </div>
      </div>
    </Card>
  );
}
