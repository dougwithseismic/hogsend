"use client";

import type { JSX } from "react";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { Section, SectionHeading } from "@/components/ds/section";
import { Explainer, SectionIntro } from "./calc-kit";

const STEPS = [
  {
    n: "01",
    title: "Instrument your product",
    body: "Fire an event for every moment that matters — signup, the activation 'aha', the key recurring action, upgrades, cancellations. PostHog (or whatever analytics you already run) is where they live. No events, no numbers.",
  },
  {
    n: "02",
    title: "Name events consistently",
    body: "One shared convention — context.object_action, past tense — keeps events composable across product, marketing and lifecycle. Sloppy names are the reason most dashboards rot.",
    href: "/event-naming",
    link: "The naming convention",
  },
  {
    n: "03",
    title: "Decide how you'll act on them",
    body: "Events are only useful if something listens. That something is lifecycle journeys: Hogsend turns your PostHog events into durable TypeScript journeys you review in a PR — so a churn signal or an activation milestone actually triggers a message.",
    href: "/use-cases/onboarding",
    link: "See a journey",
  },
] as const;

/**
 * Step 1 — the measurement foundation. Everything downstream depends on
 * capturing the events first and choosing how to act on them; this section
 * sets that up before the metric deep-dives.
 */
export function Tracking(): JSX.Element {
  return (
    <Section id="measure">
      <SectionHeading
        eyebrow="Step 1 · Measure it"
        title="You can't move a number you can't see"
        subtitle="Every lever below depends on knowing what your users actually do. Before any tactics, get the plumbing in: capture the events, name them well, and decide what listens."
      />

      <SectionIntro>
        <p>
          The numbers on this page are estimates until your product is
          instrumented. Tracking is unglamorous and it is step one for a reason
          — you cannot improve activation, churn or LTV if you cannot see them
          move. The good news: it is a one-time setup, and the same event stream
          powers both your analytics and the messages you send.
        </p>
      </SectionIntro>

      <div className="mt-10 grid gap-4 md:grid-cols-3">
        {STEPS.map((step) => (
          <Card key={step.n} className="flex flex-col">
            <span className="font-mono text-accent text-sm">{step.n}</span>
            <h3 className="mt-3 font-medium font-sans text-[17px] text-white leading-snug tracking-[-0.01em]">
              {step.title}
            </h3>
            <p className="mt-2 flex-1 text-sm text-white/60 leading-6">
              {step.body}
            </p>
            {"href" in step ? (
              <a
                href={step.href}
                className="mt-4 font-mono text-[13px] text-white/60 transition-colors hover:text-white"
              >
                {step.link} →
              </a>
            ) : null}
          </Card>
        ))}
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
        <Button href="/docs/getting-started" icon>
          Set up tracking
        </Button>
        <Button href="/integrations" variant="outline">
          See the integrations
        </Button>
      </div>

      <Explainer summary="Why does tracking come before everything else?">
        <p>
          Because every other step is a feedback loop, and a loop needs a
          signal. You decide whether to spend more on acquisition by watching
          CAC and payback; you fix churn by seeing which cohorts drop and when;
          you find the activation aha by comparing the users who stayed against
          the ones who left. None of that is possible from a billing dashboard
          alone — it needs product events.
        </p>
        <p>
          It is also why analytics and lifecycle messaging belong on the{" "}
          <b>same</b> event stream. If your "user activated" event triggers both
          a chart and an email, the thing you measure and the thing you act on
          can never drift apart. That shared stream is exactly what the rest of
          this playbook assumes you have.
        </p>
      </Explainer>
    </Section>
  );
}
