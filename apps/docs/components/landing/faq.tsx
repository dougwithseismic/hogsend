import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { Eyebrow } from "@/components/ds/badge";
import { FaqAccordion } from "@/components/ds/faq";
import { Reveal } from "@/components/ds/reveal";
import { Section } from "@/components/ds/section";

/**
 * FAQ — 9 query-phrased items with self-contained, citable answers. The
 * homepage renders FAQPage JSON-LD from this exact array (imported in
 * page.tsx), so the visible copy and the structured data never drift.
 */
export const FAQ_ITEMS = [
  {
    q: "Is Hogsend open source?",
    a: "Hogsend is source-available under the Elastic License 2.0 (ELv2), not an OSI-approved open-source license. You can read, modify, and self-host all of it for free; the only restriction is offering Hogsend itself as a managed service. All 11 packages are on npm and the full source is on GitHub.",
  },
  {
    q: "What does Hogsend cost?",
    a: "The software is free — there is no paid tier. You self-host on Railway, Docker, or any Node 22 + Postgres host, and you pay only your own infrastructure plus your Resend or Postmark account. No per-contact, per-profile, or per-send fees. If you'd rather not do the setup yourself, there's a done-for-you installation: one week, $2,300, journeys live in your repo.",
  },
  {
    q: "How is Hogsend different from PostHog Workflows?",
    a: "Workflows is PostHog's built-in no-code canvas with a managed sender — genuinely good for light automation, and free up to 10,000 messages a month (then from $0.003 per send, at the time of writing). Hogsend is typed TypeScript in your repo with durable waits, behavioral branching, and your own email provider — for when lifecycle logic outgrows boxes and arrows. There's a side-by-side comparison in the docs.",
  },
  {
    q: "How is Hogsend different from Loops?",
    a: "Loops is the polished hosted option — a visual workflow builder, sending through Loops' own infrastructure, priced per subscribed contact ($49/month at 5,000 contacts, $249/month at 50,000, checked June 2026). Hogsend is the code-first version of the same job: journeys are TypeScript files in your repo, sends go through your own Resend or Postmark account, and the software is free to self-host. Loops workflows live in their dashboard and can't be defined in code; Hogsend journeys are reviewed, versioned, and deployed like any other feature.",
  },
  {
    q: "Does Hogsend replace Resend or use it?",
    a: "It uses it. Hogsend is the orchestration layer — journeys, segments, suppression, tracking — and sends through your own Resend account by default, with Postmark as a one-env-var swap (EMAIL_PROVIDER=postmark), or any provider behind the EmailProvider contract.",
  },
  {
    q: "Can I self-host Hogsend?",
    a: "That's the only way it runs. Scaffold with create-hogsend, then deploy via the one-click Railway template (3 required env vars), Docker Compose, or any Node 22 host with Postgres and Redis. Single-tenant: your instance, your data. There is no cloud version.",
  },
  {
    q: "Do I need PostHog to use Hogsend?",
    a: "No. PostHog is the best-supported source, but events can come from Stripe, Clerk, Supabase, or Segment via built-in signed webhook presets, from your own app via the Data API or the @hogsend/client SDK, or from any custom webhook source.",
  },
  {
    q: "Can AI agents write Hogsend journeys?",
    a: "Yes — that's the point. Journeys are plain TypeScript files (defineJourney()), so Claude Code or Cursor can write and modify them like any other code, your type-checker validates them, and hogsend skills plus --json on every CLI command give agents a first-class interface.",
  },
  {
    q: "Will my emails survive a deploy mid-journey?",
    a: "Yes. Journeys run as Hatchet durable tasks: a user three days into a seven-day wait keeps waiting through deploys, restarts, and crashes, and resumes exactly where they were.",
  },
  {
    q: "Where do engagement events go?",
    a: "Back out, durably: a fixed 13-event catalog (contact, email, journey, and bucket events) fans out to PostHog, Segment, Slack, or any signed webhook — with retries, backoff, and a dead-letter queue. From PostHog you can feed conversions to Meta, Google, TikTok, LinkedIn, or Reddit via its Destinations pipeline.",
  },
];

export function Faq() {
  return (
    <Section id="faq">
      <div className="grid gap-12 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-16">
        <Reveal className="lg:sticky lg:top-28 lg:self-start">
          <Eyebrow className="mb-4">FAQ</Eyebrow>
          <h2 className="max-w-md font-display text-[32px] text-white leading-[1.2] tracking-[-0.02em] md:text-[40px] md:leading-[48px]">
            Questions, answered
          </h2>
          <p className="mt-5 max-w-sm text-base text-white/60 leading-6">
            Still curious? The docs go deeper — including a side-by-side with
            PostHog Workflows.
          </p>
          <div className="mt-7 flex flex-col items-start gap-3">
            <Link
              href="/docs"
              className="group inline-flex items-center gap-1.5 text-base text-white transition-colors hover:text-white/80"
            >
              Read the docs
              <ArrowRight
                aria-hidden="true"
                className="size-4 transition-transform duration-200 group-hover:translate-x-0.5"
                strokeWidth={1.5}
              />
            </Link>
            <Link
              href="/docs/compare/posthog-workflows"
              className="group inline-flex items-center gap-1.5 text-base text-white/70 transition-colors hover:text-white"
            >
              Hogsend vs. PostHog Workflows
              <ArrowRight
                aria-hidden="true"
                className="size-4 transition-transform duration-200 group-hover:translate-x-0.5"
                strokeWidth={1.5}
              />
            </Link>
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <FaqAccordion items={FAQ_ITEMS} />
        </Reveal>
      </div>
    </Section>
  );
}
