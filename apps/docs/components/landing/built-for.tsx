"use client";

import { AnimatePresence, motion } from "motion/react";
import { type JSX, useState } from "react";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import { AnalyticsEvent, capture } from "@/lib/analytics";
import { cn } from "@/lib/cn";

/**
 * BuiltFor — the anonymous version of the signup "what's your seat" question.
 * Same closed set of role values as /api/profile; selecting a chip swaps a
 * single matter-of-fact sentence and fires `docs.role_selected` with
 * `placement: "homepage"` (the post-signup flow uses the same event with its
 * own placement, so the two funnels stay distinguishable).
 */

type RoleValue =
  | "founder"
  | "engineer"
  | "marketing_growth"
  | "sales"
  | "just_curious";

const ROLES: { value: RoleValue; label: string; copy: string }[] = [
  {
    value: "founder",
    label: "Founder",
    copy: "Lifecycle email in the repo you already have — no second platform to buy and babysit.",
  },
  {
    value: "engineer",
    label: "Engineer",
    copy: "Journeys are TypeScript in your repo — branched, code-reviewed, and deployed like any other change you ship.",
  },
  {
    value: "marketing_growth",
    label: "Marketing & Growth",
    copy: "Every journey, send, open, and click observable in Studio — without owning the deploy or filing a ticket to see the logic.",
  },
  {
    value: "sales",
    label: "Sales",
    copy: "Product signals — trials started, milestones hit, accounts gone quiet — turned into well-timed follow-ups instead of cold check-ins.",
  },
  {
    value: "just_curious",
    label: "Just curious",
    copy: "An engine you can read end to end — scaffold it, run it locally, and delete it if it's not for you.",
  },
];

const CHIP_CLASS = cn(
  "h-10 select-none rounded-[10px] border px-4 text-sm",
  "transition-colors duration-200 outline-none",
  "focus-visible:border-white/30",
);

export function BuiltFor(): JSX.Element {
  const [role, setRole] = useState<RoleValue>("founder");
  const active = ROLES.find((option) => option.value === role) ?? ROLES[0];

  function handleSelect(next: RoleValue): void {
    if (next === role) return;
    setRole(next);
    capture(AnalyticsEvent.ROLE_SELECTED, {
      role: next,
      placement: "homepage",
    });
  }

  return (
    <Section id="built-for">
      <Reveal className="flex flex-col items-center">
        <SectionHeading
          align="center"
          eyebrow="Built for"
          title="Whose problem this solves"
          subtitle="Pick your seat — one sentence on what Hogsend gives it."
        />
      </Reveal>

      <Reveal delay={0.1} className="flex flex-col items-center">
        <div className="mt-10 flex flex-wrap justify-center gap-2">
          {ROLES.map((option) => {
            const isActive = option.value === role;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={isActive}
                onClick={() => handleSelect(option.value)}
                className={cn(
                  CHIP_CLASS,
                  isActive
                    ? "border-white/25 bg-white/[0.06] text-white"
                    : "border-white/[0.08] bg-white/[0.02] text-white/60 hover:border-white/20 hover:text-white",
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>

        <div className="mt-8 flex min-h-[84px] w-full max-w-2xl items-start justify-center md:min-h-[68px]">
          <AnimatePresence mode="wait" initial={false}>
            <motion.p
              key={active?.value}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
              className="text-center font-display text-white/80 text-xl leading-[30px] tracking-[-0.02em] md:text-2xl md:leading-[34px]"
            >
              {active?.copy}
            </motion.p>
          </AnimatePresence>
        </div>
      </Reveal>
    </Section>
  );
}
