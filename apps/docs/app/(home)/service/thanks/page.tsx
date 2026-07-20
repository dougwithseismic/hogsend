import { Check } from "lucide-react";
import type { Metadata } from "next";
import type { JSX } from "react";
import { Eyebrow } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { AuroraBeam } from "@/components/ds/fx";
import { Reveal } from "@/components/ds/reveal";
import { Section } from "@/components/ds/section";

// Post-purchase confirmation — never indexed.
export const metadata: Metadata = {
  title: "Thank you",
  robots: { index: false, follow: false },
};

type Plan = "audit" | "build";

const COPY: Record<Plan, { title: string; body: string; next: string }> = {
  audit: {
    title: "Your lifecycle audit is booked",
    body: "Payment's in — thank you. I'll email you within a day to lock the week and gather what I need: your analytics, your email provider, and where you think the funnel leaks.",
    next: "Want a head start? The docs walk through the pieces I'll be looking at.",
  },
  build: {
    title: "Your build is booked",
    body: "Payment's in — thank you. I'll email you within a day to lock the kickoff date and gather access: your repo, your analytics, and your email provider.",
    next: "While we wait, the docs cover how everything fits together.",
  },
};

function planFrom(value: string | string[] | undefined): Plan {
  return value === "build" ? "build" : "audit";
}

export default async function ServiceThanksPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string | string[] }>;
}): Promise<JSX.Element> {
  const { plan } = await searchParams;
  const copy = COPY[planFrom(plan)];

  return (
    <main className="flex flex-1 flex-col">
      <Section divider={false} containerClassName="container-page pt-32 pb-24">
        <AuroraBeam className="opacity-60" />
        <Reveal className="relative z-10 mx-auto flex max-w-2xl flex-col items-center text-center">
          <span className="mb-6 grid size-12 place-items-center rounded-full border border-accent/40 bg-accent/10 text-accent">
            <Check className="size-6" strokeWidth={2} />
          </span>
          <Eyebrow className="mb-4">Payment received</Eyebrow>
          <h1 className="max-w-2xl font-display text-[32px] text-white leading-[1.15] tracking-[-0.02em] md:text-[40px] md:leading-[48px]">
            {copy.title}
          </h1>
          <p className="mt-6 max-w-xl text-base text-white/70 leading-7">
            {copy.body}
          </p>
          <p className="mt-4 max-w-xl text-base text-white/60 leading-7">
            {copy.next}
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-4">
            <Button href="/docs/getting-started" variant="accent" icon>
              Read the docs
            </Button>
            <Button href="/" variant="outline">
              Back to home
            </Button>
          </div>
        </Reveal>
      </Section>
    </main>
  );
}
