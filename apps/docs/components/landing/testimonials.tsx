import { ArrowUpRight } from "lucide-react";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import { cn } from "@/lib/cn";

type Testimonial = {
  /** Serif card headline — the one-liner takeaway. */
  headline: string;
  /** Short illustrative quote in the dev's voice. */
  quote: string;
  /** Initials shown in the avatar circle. */
  initials: string;
  name: string;
  role: string;
};

/**
 * Illustrative, clearly-demo personas. Hogsend-flavored devs and founders
 * shipping lifecycle email on PostHog + Resend — quotes are not real customers.
 */
const TESTIMONIALS: Testimonial[] = [
  {
    headline: "From config to code",
    quote:
      "We ripped out a tangle of canvas branches and rewrote the whole onboarding flow as one TypeScript function. It finally reads like the rest of our app.",
    initials: "MR",
    name: "Maya Rao",
    role: "Staff engineer, devtool startup",
  },
  {
    headline: "Shipped in an afternoon",
    quote:
      "Scaffolded with create-hogsend before lunch, had a trial-nudge journey live by the afternoon. No new dashboard to learn — just events in, sends out.",
    initials: "TL",
    name: "Tom Liang",
    role: "Founder, solo SaaS",
  },
  {
    headline: "No more YAML",
    quote:
      "Our flows live in git now. Code review, types, tests — the same workflow as everything else. The drag-and-drop builder is finally gone.",
    initials: "PS",
    name: "Priya Sharma",
    role: "Lead developer, fintech",
  },
  {
    headline: "Lifecycle that just runs",
    quote:
      "Hatchet handles the durable waits, so a journey can sleep three days and pick up exactly where it left off. We stopped babysitting cron jobs.",
    initials: "DK",
    name: "Dan Keller",
    role: "Growth engineer, B2B",
  },
];

/**
 * "Testimonials" — a TEAL rounded panel with a 2x2 grid of bordered cards on
 * the teal. Each card: a light-serif headline, a short illustrative quote, an
 * avatar circle with initials, a name + role, and an ArrowUpRight top-right.
 * A homage to the Wispr Flow testimonials wall, with Hogsend-flavored demo
 * personas (clearly illustrative — not real customers).
 */
export function Testimonials() {
  return (
    <Section tone="teal" id="testimonials">
      <Reveal>
        <SectionHeading
          tone="teal"
          align="center"
          eyebrow="FROM THE TEAM"
          title="Loved by people who'd rather write code"
          subtitle="Illustrative voices from the kind of developers and founders Hogsend is built for — events in, sends out, all in plain TypeScript."
        />
      </Reveal>

      <div className="mx-auto mt-12 grid max-w-4xl grid-cols-1 gap-5 md:mt-16 md:grid-cols-2">
        {TESTIMONIALS.map((item, index) => (
          <Reveal key={item.headline} delay={(index % 2) * 0.08}>
            <TestimonialCard {...item} />
          </Reveal>
        ))}
      </div>
    </Section>
  );
}

/** A single bordered card sitting on the teal panel. */
function TestimonialCard({
  headline,
  quote,
  initials,
  name,
  role,
}: Testimonial) {
  return (
    <figure
      className={cn(
        "group relative flex h-full flex-col rounded-3xl p-7",
        // A slightly lighter, bordered teal surface so cards read distinctly
        // against the fathom panel behind them.
        "border border-lumen/15 bg-lumen/[0.06]",
      )}
    >
      <ArrowUpRight
        aria-hidden="true"
        strokeWidth={1.75}
        className="absolute top-6 right-6 size-5 text-lumen/40 transition-colors group-hover:text-glow"
      />

      <h3 className="font-display max-w-[14ch] text-[1.6rem] leading-[1.15] tracking-tight text-lumen md:text-[1.75rem]">
        {headline}
      </h3>

      <blockquote className="mt-4 flex-1 font-sans text-sm leading-relaxed text-lumen/70 md:text-base">
        “{quote}”
      </blockquote>

      <figcaption className="mt-7 flex items-center gap-3">
        <span
          aria-hidden="true"
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-lumen/20 bg-glow/20 font-sans text-sm font-semibold text-lumen"
        >
          {initials}
        </span>
        <span className="flex flex-col leading-tight">
          <span className="font-sans text-sm font-semibold text-lumen">
            {name}
          </span>
          <span className="font-sans text-xs text-lumen/55">{role}</span>
        </span>
      </figcaption>
    </figure>
  );
}
