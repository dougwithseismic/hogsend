import type { Metadata } from "next";
import { type JSX, Suspense } from "react";
import { Eyebrow } from "@/components/ds/badge";
import { Section } from "@/components/ds/section";
import { PlaybookExplorer } from "@/components/playbook/playbook-explorer";
import { getAllPlays, toPlayIndex } from "@/lib/playbook";

export const metadata: Metadata = {
  title: "The Growth Engineer's Playbook",
  description:
    "Short, concrete lifecycle plays that install — categorized by stage and role, each with the journey code that runs it.",
  alternates: { canonical: "/playbook" },
};

export default function PlaybookPage(): JSX.Element {
  const plays = toPlayIndex(getAllPlays());

  return (
    <main className="flex flex-1 flex-col">
      <Section divider={false} containerClassName="pt-32 pb-12">
        <Eyebrow className="mb-4">The Playbook</Eyebrow>
        <h1 className="max-w-3xl font-display text-[40px] text-white leading-[1.1] tracking-[-0.02em] md:text-[56px]">
          Plays that install
        </h1>
        <p className="mt-5 max-w-2xl text-base text-white/60 leading-6">
          Lifecycle normally shows results in a month. If you're sending traffic
          without a robust lifecycle system, these plays show results within a
          day — each one ends with the journey code that runs it.
        </p>
      </Section>

      <Section containerClassName="py-12">
        <Suspense>
          <PlaybookExplorer plays={plays} />
        </Suspense>
      </Section>
    </main>
  );
}
