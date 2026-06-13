import Link from "next/link";
import { Reveal } from "@/components/ds/reveal";
import { cn } from "@/lib/cn";
import { ENGINE_VERSION } from "@/lib/site";

/**
 * ProofStrip — the crimzon stats band: a two-line 16px label on the left,
 * three stats separated by vertical hairlines on the right (40px number +
 * 12px uppercase caption), and a founder micro-line beneath.
 *
 * HARD RULE: every number here comes from the research brief's verified proof
 * inventory (11 npm packages, 13 templates, 10 journeys); the release version
 * comes from ENGINE_VERSION. This strip
 * is "what exists", not "who uses it" — never add usage claims, customer
 * counts, or invented logos.
 */

type StatItem = {
  value: string;
  label: string;
  href: string;
  external?: boolean;
};

const STATS: StatItem[] = [
  { value: `v${ENGINE_VERSION}`, label: "Current release", href: "/changelog" },
  {
    value: "11",
    label: "Packages on npm",
    href: "https://www.npmjs.com/package/@hogsend/engine",
    external: true,
  },
  {
    value: "13",
    label: "React Email templates",
    href: "/emails",
  },
];

export function ProofStrip({ className }: { className?: string }) {
  return (
    // No top hairline — LogoStrip's border-y already draws it.
    <section className={cn("relative text-white", className)}>
      <div className="container-page py-16 md:py-20">
        <Reveal>
          <div className="flex flex-col gap-10 lg:flex-row lg:items-center lg:justify-between">
            <p className="max-w-[300px] text-base text-white/80 leading-6">
              Journeys are TypeScript files in your repo. Everything else
              follows from that.
            </p>

            <div className="flex flex-col gap-8 sm:flex-row sm:gap-0">
              {STATS.map((stat, index) => {
                const inner = (
                  <>
                    <span className="font-sans text-[40px] text-white leading-[48px] tracking-[-0.02em]">
                      {stat.value}
                    </span>
                    <span className="eyebrow text-white/50">{stat.label}</span>
                  </>
                );

                const cell = cn(
                  "group flex flex-col gap-2 sm:px-10 first:sm:pl-0 last:sm:pr-0",
                  index > 0 && "sm:border-white/10 sm:border-l",
                );

                return stat.external ? (
                  <a
                    key={stat.value}
                    href={stat.href}
                    target="_blank"
                    rel="noreferrer"
                    className={cell}
                  >
                    {inner}
                  </a>
                ) : (
                  <Link key={stat.value} href={stat.href} className={cell}>
                    {inner}
                  </Link>
                );
              })}
            </div>
          </div>

          <p className="mt-10 text-sm text-white/50">
            Built by a growth engineer after 15+ years of client work — and one
            too many hand-rolled lifecycle stacks.{" "}
            <Link
              href="/about"
              className="text-white/70 transition-colors hover:text-white"
            >
              The story →
            </Link>
          </p>
        </Reveal>
      </div>
    </section>
  );
}
