import type { Metadata } from "next";
import { type JSX, Suspense } from "react";
import { Eyebrow } from "@/components/ds/badge";
import { Section } from "@/components/ds/section";
import { HalftoneOverlay, ThermalLayer } from "@/components/ds/thermal";
import { PlaybookCapture } from "@/components/playbook/playbook-capture";
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
      {/* Hero — the homepage treatment: crimzon horizon glow + morphing
          thermal smoke + halftone, centered display copy (see PsHero). */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-40 mix-blend-screen"
          style={{
            background:
              "radial-gradient(90% 60% at 50% 115%, rgba(246,72,56,0.28) 0%, rgba(246,72,56,0.1) 45%, transparent 75%)",
          }}
        />
        <ThermalLayer strength={0.17} />
        <HalftoneOverlay className="opacity-40" />
        <div className="container-page relative flex flex-col items-center pt-32 pb-16 text-center md:pb-24">
          <Eyebrow className="mb-4">The Playbook</Eyebrow>
          <h1 className="max-w-3xl font-display text-[40px] text-white leading-[1.1] tracking-[-0.02em] md:text-[64px]">
            Plays that install
          </h1>
          <p className="mt-5 max-w-2xl text-base text-white/70 leading-6 md:text-lg md:leading-7">
            Lifecycle normally shows results in a month. If you're sending
            traffic without a robust lifecycle system, these plays show results
            within a day — each one ends with the journey code that runs it.
          </p>
        </div>
      </section>

      <Section containerClassName="py-12">
        <Suspense>
          <PlaybookExplorer plays={plays} />
        </Suspense>
      </Section>

      <Section containerClassName="py-16">
        <PlaybookCapture placement="index" className="mx-auto max-w-xl" />
      </Section>
    </main>
  );
}
