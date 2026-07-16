import Link from "next/link";
import type { JSX } from "react";

const RUNGS = [
  {
    label: "Do it yourself",
    copy: "Self-host Hogsend and ship this play from your repo.",
    href: "/docs",
    cta: "Read the docs",
  },
  {
    label: "Managed",
    copy: "We run the infrastructure; you write the journeys.",
    href: "/pricing",
    cta: "See pricing",
  },
  {
    label: "Done for you",
    copy: "We design, build, and run your lifecycle system.",
    href: "/service",
    cta: "Talk to us",
  },
] as const;

/** The three-rung ladder block at the bottom of every play (no tracking yet). */
export function LadderCta(): JSX.Element {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {RUNGS.map((rung) => (
        <Link
          key={rung.href}
          href={rung.href}
          className="group flex flex-col gap-2 rounded-md border border-white/[0.08] bg-white/[0.015] p-5 transition-colors duration-200 hover:border-white/15"
        >
          <span className="font-mono text-[11px] text-white/45 uppercase tracking-[0.06em]">
            {rung.label}
          </span>
          <p className="text-[14px] text-white/60 leading-[1.55]">
            {rung.copy}
          </p>
          <span className="mt-auto pt-2 text-sm text-white underline underline-offset-4 decoration-white/30 transition-colors group-hover:decoration-white/70">
            {rung.cta}
          </span>
        </Link>
      ))}
    </div>
  );
}
