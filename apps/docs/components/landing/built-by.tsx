import { Mail } from "lucide-react";
import { Eyebrow } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { Reveal } from "@/components/ds/reveal";
import { Section } from "@/components/ds/section";

const ABOUT_URL = "/docs/about";
const EMAIL = "doug@withseismic.com";
const LINKEDIN = "https://linkedin.com/in/dougsilkstone";

/**
 * "Built by" — a personal strawberry panel near the foot of the page. Hogsend is
 * a solo, consultant-built tool (positioning: code-first wedge for devs and
 * consultants), so this puts a face + a direct line to the maker on the landing.
 * Copy is drawn from the docs About page (content/docs/about.mdx).
 */
export function BuiltBy() {
  return (
    <Section tone="teal" id="built-by">
      <Reveal className="mx-auto flex max-w-3xl flex-col items-center text-center">
        <span
          aria-hidden="true"
          className="flex size-16 items-center justify-center rounded-full border-2 border-ink bg-ink font-display text-2xl text-lumen"
        >
          DS
        </span>

        <Eyebrow tone="light" className="mt-6">
          Built by
        </Eyebrow>

        <h2 className="mt-4 max-w-2xl font-display text-[clamp(2rem,4vw,3.25rem)] leading-[1.05] tracking-tight text-ink">
          Made by an engineer who kept rebuilding it
        </h2>

        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-ink/70">
          I&apos;m Doug Silkstone — a freelance product engineer. After 15+
          years shipping for startups, I&apos;d duct-taped PostHog to Resend for
          client after client, so I finally built it properly once. Want
          lifecycle emails live in your stack in days, not weeks? Read the
          story, or just email me — no forms, no &ldquo;book a call,&rdquo; no
          SDR in the middle.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-4">
          <Button href={ABOUT_URL} variant="accent" icon>
            Read the story
          </Button>

          <a
            href={`mailto:${EMAIL}`}
            className="inline-flex items-center gap-2 font-sans text-ink/70 underline decoration-ink/30 underline-offset-4 transition-colors hover:text-ink hover:decoration-ink"
          >
            <Mail className="size-4" aria-hidden="true" />
            {EMAIL}
          </a>

          <a
            href={LINKEDIN}
            target="_blank"
            rel="noreferrer"
            className="font-sans text-ink/70 underline decoration-ink/30 underline-offset-4 transition-colors hover:text-ink hover:decoration-ink"
          >
            LinkedIn
          </a>
        </div>
      </Reveal>
    </Section>
  );
}
