import type { JSX } from "react";
import { Eyebrow } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { AuroraBeam } from "@/components/ds/fx";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import { EmailCapture } from "@/components/landing/email-capture";
import { ReferralViewPing } from "./referral-view-ping";

/** The four flows every product ends up needing — same list as the homepage. */
const LIFECYCLE_FLOWS = [
  "Welcome series",
  "Trial nudges",
  "Win-backs",
  "Payment saves",
];

/**
 * ReferralLanding — the /hey/[name] page body. A referred founder lands here
 * from a note a builder they know passed on; `name` is the sanitised display
 * name from the URL segment, or null for the generic fallback. The capture
 * section closes the loop: a subscribe here fires `docs.subscribed` and
 * enrols them in the same docs-subscriber journey that wrote to the referrer.
 */
export function ReferralLanding({
  name,
}: {
  name: string | null;
}): JSX.Element {
  return (
    <main className="flex flex-1 flex-col">
      {/* Hero — a question, not a pitch. */}
      <Section
        divider={false}
        className="relative overflow-hidden"
        containerClassName="container-page pt-32 pb-20"
      >
        <AuroraBeam />
        <div className="relative z-10 flex flex-col items-center text-center">
          <Reveal className="flex flex-col items-center">
            <Eyebrow>A note passed on</Eyebrow>
            <h1 className="mt-6 max-w-4xl font-display font-medium text-[40px] text-white leading-[1.2] tracking-[-0.05em] md:text-[56px] md:leading-[64px]">
              {name ? (
                <>Hey {name} — are the lifecycle basics actually running?</>
              ) : (
                <>
                  Sent here by someone who builds — are the lifecycle basics
                  actually running?
                </>
              )}
            </h1>
            <p className="mt-6 max-w-xl text-base text-white/60 leading-6">
              A builder you know passed this on. Quick question first: every
              product ends up needing the same four flows —
            </p>
            <ul className="mt-6 flex flex-col items-start gap-2">
              {LIFECYCLE_FLOWS.map((flow) => (
                <li key={flow} className="text-[15px] text-white/70 leading-6">
                  <span className="mr-2 font-medium text-accent">→</span>
                  {flow}
                </li>
              ))}
            </ul>
            <p className="mt-6 max-w-xl text-base text-white/60 leading-6">
              If those are running and working, close the tab — genuinely. If
              some of them are still on the list, read on.
            </p>
          </Reveal>
        </div>
        <ReferralViewPing personalised={name !== null} />
      </Section>

      {/* The offer, plainly. */}
      <Section>
        <Reveal>
          <SectionHeading
            eyebrow="The offer, plainly"
            title="Hogsend puts them in your repo"
            subtitle="Journeys are TypeScript functions in your repo — versioned, reviewed, and deployed like the rest of your stack — triggered by your PostHog events and sent through your own Resend or Postmark account. It's free to self-host, and one scaffold command has it working by this afternoon."
          />
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <Button href="/docs/getting-started" icon>
              Start building
            </Button>
            <Button href="/docs" variant="outline">
              Read the docs first
            </Button>
          </div>
          <p className="mt-4 text-sm text-white/40">
            Free to self-host · No per-contact billing
          </p>
        </Reveal>
      </Section>

      {/* Capture — the loop-closer: subscribing here enters docs-subscriber. */}
      <Section>
        <Reveal>
          <SectionHeading
            align="center"
            title="See it run on yourself"
            subtitle="Drop your email and the welcome journey fires through a stock create-hogsend app — the same code you'd scaffold."
          />
          <EmailCapture
            hideHeading
            placement="referral"
            className="mx-auto mt-8 w-full max-w-md"
          />
        </Reveal>
      </Section>
    </main>
  );
}
