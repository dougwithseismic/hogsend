import type { Metadata } from "next";
import type { JSX } from "react";
import { EventNameChecker } from "@/components/landing/event-name-checker";
import {
  ClosingCta,
  CodeWalkthrough,
  type FaqItem,
  PointsGrid,
  ProblemStatement,
  UseCaseFaq,
  UseCaseHero,
} from "../use-cases/_components/use-case-sections";

export const metadata: Metadata = {
  title: "Event naming convention for product analytics",
  description:
    "context.object_action — lowercase snake_case, past tense, one dot of context. The event naming convention every Hogsend event follows, why it disagrees with PostHog's guide on tense, and the anti-patterns it exists to prevent.",
  alternates: { canonical: "/event-naming" },
  keywords: [
    "event naming convention",
    "product analytics",
    "posthog",
    "event tracking",
    "snake_case events",
    "analytics best practices",
    "lifecycle email",
    "code-first",
  ],
};

/* Mirrors the scaffold's src/journeys/constants/ pattern — the convention
   applied, with the rules visible in the names themselves. */
const CONSTANTS_CODE = `// src/journeys/constants/index.ts
// context.object_action — lowercase, snake_case, past tense, one dot.
export const Events = {
  // docs site
  DOCS_SUBSCRIBED: "docs.subscribed",
  DOCS_PAGE_VIEWED: "docs.page_viewed",
  DOCS_DEPLOY_CLICKED: "docs.deploy_clicked",

  // product lifecycle
  USER_CREATED: "user.created",
  TRIAL_STARTED: "trial.started",
  SUBSCRIPTION_STARTED: "subscription.started",

  // emitted by the Hogsend engine — same convention
  EMAIL_OPENED: "email.opened",
  EMAIL_LINK_CLICKED: "email.link_clicked",
  JOURNEY_COMPLETED: "journey.completed",
} as const;`;

const PROPERTIES_CODE = `// One event, many properties — variance never goes in the name.

// Wrong: one event definition per docs section, forever.
capture(\`docs.\${section}_page_viewed\`);

// Right: one event; the section is a dimension you filter on.
capture("docs.page_viewed", { section: "api", slug: "api/events" });

// "Viewed 3+ API reference pages" is now ONE filter on ONE event —
// and a Hogsend bucket criterion, not a union of twelve names:
b.event("docs.page_viewed")
  .where("section", "eq", "api")
  .within(days(30))
  .atLeast(3);`;

const POINTS = [
  {
    title: "One dot of context",
    body: "docs., email., trial., billing. — the dot scopes the event to the system that produced it, so names sort together, filter together, and never collide with whatever your stack invents next year. One dot only; billing.invoice.payment.failed is a hierarchy looking for a problem.",
  },
  {
    title: "Past tense, on purpose",
    body: "An event is a record of something that happened — deploy_clicked states a fact, deploy_click reads like a command. PostHog's guide says present tense; Segment's Object–Action framework says past. We side with Segment, and the engine already agrees: email.opened, journey.completed, trial.started.",
  },
  {
    title: "Object before verb",
    body: "deploy_clicked, not clicked_deploy. Noun-first puts every event about the same thing next to each other in an alphabetised dropdown — all the page_* events together, all the payment_* events together. Verb-first groups by interaction type, which is never the question.",
  },
  {
    title: "A closed verb list",
    body: "viewed, clicked, copied, submitted, started, completed, failed, created, updated, deleted, entered, left — pick the verbs once and never improvise. The point is that tapped, pressed, and clicked never coexist. A new verb is a code-reviewed decision, not a vibe at the call site.",
  },
  {
    title: "One event, many properties",
    body: "A name is an identity; a property is a dimension. Interpolating values into names — docs.api_page_viewed, docs.cli_page_viewed — produces hundreds of definitions that can't be grouped or graphed together. Fixed name, variance in properties, always.",
  },
  {
    title: "Same action, same name, everywhere",
    body: "If a deploy click is captured in the browser and forwarded to your lifecycle engine, both events are docs.deploy_clicked. The distinction worth keeping isn't transport — it's interaction events (a form was submitted) versus domain events (a subscriber now exists). The gap between those two is the funnel.",
  },
];

const FAQ_ITEMS: FaqItem[] = [
  {
    q: "Why past tense when PostHog's own guide says present?",
    a: "PostHog recommends present-tense verbs; Segment's Object–Action framework — the older, more widely adopted convention — recommends past tense, because an event is a record of a completed action. Hogsend's engine events were past tense before the convention was written down (email.opened, journey.completed), so present tense would mean fighting the platform. Both guides agree on everything else: lowercase, snake_case, never interpolate.",
  },
  {
    q: "What are the colons in events like bucket:entered:power-users?",
    a: "Deliberate contrast: dots mark domain events you author, colons mark system transitions the Hogsend engine fires. Bucket aliases embed your bucket id in the name, which works because ids are a closed, code-reviewed set with typed refs. Don't adopt colons for your own events.",
  },
  {
    q: "We already have a mess of names. Worth renaming?",
    a: "Yes, and early — a few weeks of orphaned history is cheaper than a permanent inconsistency. Define the constants map, rename at the source, and take the break. PostHog can rename events for display and its taxonomy standardizer can remap incoming names if you need a bridge during the transition.",
  },
  {
    q: "Do properties follow the convention too?",
    a: "Same casing: snake_case names and snake_case enum values (marketing_growth, not Marketing/Growth). Booleans get is_/has_ prefixes, timestamps get an _at suffix, and anything you plan to group by stays low-cardinality — a section with eleven values is an insight, a raw URL with ten thousand is not.",
  },
];

const FAQ_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ_ITEMS.map((item) => ({
    "@type": "Question",
    name: item.q,
    acceptedAnswer: { "@type": "Answer", text: item.a },
  })),
};

export default function EventNamingPage(): JSX.Element {
  return (
    <main className="flex flex-1 flex-col">
      <script
        type="application/ld+json"
        // Static literal defined above — no user input flows in.
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD
        dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_JSON_LD) }}
      />

      <UseCaseHero
        eyebrow="Guide: event naming"
        title="One way to name events, written down"
        subhead="context.object_action — lowercase, snake_case, past tense, one dot. The convention every Hogsend event already follows, written down so your whole stack can follow it too."
      />

      <ProblemStatement label="The problem">
        Sign Up, signup, user_signed_up, and userSignedUp are four names for one
        action. Six months in, every funnel needs a translation table, nobody
        trusts the chart, and the fix costs a break in event history. Naming is
        the cheapest piece of analytics infrastructure you'll ever ship — and
        the most expensive one to retrofit.
      </ProblemStatement>

      <CodeWalkthrough
        eyebrow="The convention"
        title="One pattern, defined once"
        subtitle="Names are fixed strings in an as-const map; call sites import the constant. A typo in a string literal is an event that silently never matches a journey trigger — a typo in a constant is a compile error."
        blocks={[
          {
            filename: "src/journeys/constants/index.ts",
            code: CONSTANTS_CODE,
            caption:
              "The whole convention in one file: one dot of context, object before verb, past tense, lowercase snake_case. Engine-emitted events follow the same pattern as yours.",
          },
          {
            filename: "capture.ts",
            code: PROPERTIES_CODE,
            caption:
              "The most expensive mistake in event design is variance in the name. One event with a section property is one filter in PostHog and one bucket criterion in Hogsend; twelve interpolated names are a union nobody maintains.",
          },
        ]}
      />

      <PointsGrid
        eyebrow="The rules"
        title="Six rules, no exceptions"
        subtitle="Short enough to fit in a code review comment. Strict enough that two engineers naming events a year apart produce the same name."
        points={POINTS}
      />

      <EventNameChecker />

      <UseCaseFaq
        items={FAQ_ITEMS}
        links={[
          {
            label: "Event naming — the full guide",
            href: "/docs/guides/event-naming",
          },
          { label: "Sending events to Hogsend", href: "/docs/guides/events" },
          {
            label: "Buckets — criteria on event properties",
            href: "/docs/guides/buckets",
          },
          {
            label: "PostHog setup",
            href: "/docs/getting-started/posthog-setup",
          },
        ]}
      />

      <ClosingCta
        title="One convention for every event"
        subtitle="The scaffold ships the constants file, the journeys that consume it, and the engine events that already follow the same pattern."
      />
    </main>
  );
}
