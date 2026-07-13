import type { Metadata } from "next";
import type { JSX } from "react";
import { ProseSection } from "../campaigns/_components/campaigns-sections";
import {
  ClosingCta,
  CodeWalkthrough,
  type FaqItem,
  PointsGrid,
  ProblemStatement,
  UseCaseFaq,
} from "../use-cases/_components/use-case-sections";
import { LoopPanel, PaidHero } from "./_components/paid-sections";

export const metadata: Metadata = {
  title: "Paid acquisition — make your paid budget go further",
  description:
    "Every ad click, form fill, quote and closed deal on one contact timeline — fed back to Meta server-side with real values and the original click. Campaigns optimize toward buyers, not clickers.",
  alternates: { canonical: "/paid" },
  keywords: [
    "meta conversions api",
    "server-side conversion tracking",
    "capi",
    "conversion tracking",
    "revenue attribution",
    "lead tracking",
    "click id capture",
    "fbclid",
    "roas",
    "lifecycle marketing",
  ],
};

/* Mirrors apps/api/src/conversions — every shape is exact. */
const DEFINE_CONVERSION_CODE = `import { defineConversion } from "@hogsend/engine";

export const dealSold = defineConversion({
  id: "deal-sold",
  trigger: { event: "deal.sold" },
  destinations: ["meta-capi"],
  // value defaults to the event's own first-class value;
  // browser (pk_) events are rejected — values can't be forged
});

export const bigQuote = defineConversion({
  id: "big-quote",
  trigger: {
    event: "deal.quoted",
    where: (b) => b.prop("value").gte(10_000),
  },
  destinations: ["meta-capi"],
});`;

const WIRE_DESTINATION_CODE = `import { createMetaCapiDestination } from "@hogsend/plugin-meta-capi";

const client = createHogsendClient({
  journeys,
  conversions,
  conversionDestinations: [
    createMetaCapiDestination({
      pixelId: process.env.META_PIXEL_ID!,
      accessToken: process.env.META_CAPI_TOKEN!,
    }),
  ],
});`;

const FAQ_ITEMS: FaqItem[] = [
  {
    q: "Where do click IDs come from if conversions fire server-side?",
    a: "The browser SDK captures them first-party the moment someone lands from an ad — fbclid, gclid, ttclid and eight more, with the real click timestamp — as a campaign.arrived event. At conversion time the engine recovers the contact's latest one and hands it to the destination.",
  },
  {
    q: "Do I need Meta's browser Pixel?",
    a: "No. The CAPI events stand alone. If you do run the Pixel, send the same event_id from it and Meta counts each conversion once — the engine's id is deterministic, so retries and re-evaluations never inflate numbers.",
  },
  {
    q: "Can a visitor fake a conversion value?",
    a: "No. Browser events are publishable-key trust tier, so conversion points reject them by default — values come from server-side sources: CRM stage changes, your API, webhook sources. Opening a definition to browser events is an explicit opt-in.",
  },
  {
    q: "Which CRMs can feed the deals ledger?",
    a: "Any CRM that can send a webhook or be polled, via the defineCrmProvider contract with a per-pipeline stage map. Reference implementations for GoHighLevel, Attio, and HubSpot live in the repo.",
  },
  {
    q: "What about Google, TikTok, LinkedIn, Reddit?",
    a: "Documented today via PostHog's Destinations pipeline, which reads the same event stream Hogsend mirrors. Meta is the first native destination; the contract (defineConversionDestination) is public, so others are a plugin away.",
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

export default function PaidPage(): JSX.Element {
  return (
    <main className="flex flex-1 flex-col">
      <script
        type="application/ld+json"
        // Static literal defined above — no user input flows in.
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD
        dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_JSON_LD) }}
      />

      <PaidHero />

      <ProblemStatement label="The coin flip">
        You pay per click, but the platform optimizes on whatever you feed it.
        Feed it form-fills and it finds form-fillers. Between the click and the
        sale sits your CRM — and the ad platform never hears about it. That's
        spending on heads-or-tails.
      </ProblemStatement>

      <LoopPanel />

      <ProseSection eyebrow="The bucket" title="Pennies in, nothing leaks">
        Hogsend already runs your lifecycle marketing, so every touchpoint
        between click and revenue is on record: the landing, the emails they
        opened on day three, the SMS they clicked, the quote, the close. The
        same events that drive your journeys are the attribution evidence — each
        penny lands in the bucket instead of riding another coin flip.
      </ProseSection>

      <CodeWalkthrough
        eyebrow="Authoring"
        title="A conversion point is a committed file"
        subtitle="Declare which events count, what they're worth, and where they dispatch — reviewed like any other change."
        blocks={[
          {
            filename: "src/conversions/index.ts",
            code: DEFINE_CONVERSION_CODE,
            caption:
              "The trigger uses the same condition builder journeys use — the event's first-class value is visible to it, so “only quotes over £10k” is one line.",
          },
          {
            filename: "src/index.ts",
            code: WIRE_DESTINATION_CODE,
            caption:
              "The token is self-serve from Meta's Events Manager — no app review. Fired conversions are recorded durably, then delivered by a retrying task with a deterministic dedup id.",
          },
        ]}
      />

      <PointsGrid
        eyebrow="What ships"
        title="The whole loop, first-party"
        subtitle="No third-party pixel dependency, no black-box attribution vendor. Every piece runs in your deployment and writes to your database."
        points={[
          {
            title: "Value on events",
            body: "Any event can carry a monetary worth — a real column, not a property convention. Rollups are per-currency, never cross-summed, and your PostHog mirror sees the same numbers.",
          },
          {
            title: "First-party click capture",
            body: (
              <>
                Landings with <code>fbclid</code>, <code>gclid</code>,{" "}
                <code>ttclid</code> and eight more (or any <code>utm_*</code>)
                fire <code>campaign.arrived</code> automatically, deduped per
                session, persisted as last-touch.
              </>
            ),
          },
          {
            title: "Lead intake from any form",
            body: "Heyflow, Perspective, Webflow, your own React form — one webhook source turns any vendor's POST into lead.submitted, identity-stitched to the ad click via hidden fields.",
          },
          {
            title: "The deals ledger",
            body: (
              <>
                CRM stages map onto canonical ones — lead, contacted,
                survey&nbsp;booked, quoted, sold — monotonically, so a late
                webhook never regresses a closed deal. Quoted and sold mint
                valued events.
              </>
            ),
          },
          {
            title: "Conversion points",
            body: "defineConversion declares which events count, with a forged-value guard and three value sources. Fired instances are recorded once per event — replays can't double-fire.",
          },
          {
            title: "Meta CAPI, done properly",
            body: (
              <>
                Hashed identifiers per Meta's spec, <code>fbc</code> rebuilt
                from the real stored click (never fabricated), CRM-grade{" "}
                <code>action_source</code>, and a deterministic{" "}
                <code>event_id</code> reused across retries.
              </>
            ),
          },
        ]}
      />

      <ProseSection eyebrow="Studio" title="Revenue front and center">
        The Deals view puts the money where you can see it: sold last 30 days
        and lifetime, open pipeline, average order value, and time-to-close —
        per currency — over a board of every deal grouped by canonical stage.
        Contacts filter by minimum revenue and current deal stage, so
        &ldquo;quoted over £10k and gone quiet&rdquo; is a filter, not a
        spreadsheet afternoon.
      </ProseSection>

      <UseCaseFaq
        items={FAQ_ITEMS}
        links={[
          { label: "Guide: revenue tracking", href: "/docs/guides/revenue" },
          { label: "Guide: lead intake", href: "/docs/guides/lead-intake" },
          {
            label: "Conversions & ad-platform feedback",
            href: "/docs/conversions",
          },
          { label: "Meta CAPI setup", href: "/docs/conversions/meta-ads" },
        ]}
      />

      <ClosingCta
        title="Close the loop on revenue"
        subtitle="Deploy Hogsend, point your lead form at it, and send Meta the sale — not the click."
      />
    </main>
  );
}
