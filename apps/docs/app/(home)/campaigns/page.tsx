import type { Metadata } from "next";
import type { JSX } from "react";
import {
  ClosingCta,
  CodeWalkthrough,
  type FaqItem,
  PointsGrid,
  ProblemStatement,
  UseCaseFaq,
} from "../use-cases/_components/use-case-sections";
import { CampaignsHero, ProseSection } from "./_components/campaigns-sections";

export const metadata: Metadata = {
  title: "Campaigns — one-off sends to your whole audience",
  description:
    "Broadcast one template to every subscribed member of a list, at an instant you pick. Commit the campaign as a file or queue it with one API call — scheduled, cancelable until send, deduplicated per recipient.",
};

/* Mirrors packages/create-hogsend/template/src/campaigns/product-launch.ts —
   the id and sendAt are illustrative; every shape is exact. */
const DEFINE_CAMPAIGN_CODE = `import { defineCampaign } from "@hogsend/engine";

export const productLaunch = defineCampaign({
  id: "product-launch",
  audience: { list: "product-updates" },
  template: "marketing/product-update",
  props: {
    headline: "Saved views are here",
    ctaUrl: "https://example.com/changelog",
  },
  sendAt: "2026-07-15T16:00:00Z",
});`;

const SDK_SEND_CODE = `await hs.campaigns.send({
  list: "product-updates",
  template: "marketing/product-update",
  props: { headline: "Saved views are here" },
  sendAt: "2026-07-15T16:00:00Z",
  idempotencyKey: "launch-2026-07",
});`;

const FAQ_ITEMS: FaqItem[] = [
  {
    q: "How is a campaign different from a journey?",
    a: "A journey is triggered per user and has control flow — waits, branches, event checks. A campaign has none of that: one template, one audience, one instant. It fires once and is retired.",
  },
  {
    q: "Can I send to an ad-hoc list of addresses?",
    a: "No. The audience is a registered list or bucket, resolved at send time. Import contacts into a list first — that's what keeps unsubscribe enforceable.",
  },
  {
    q: "What happens if the worker crashes mid-send?",
    a: "The campaign stays re-runnable and the reaper re-enqueues it. Per-recipient idempotency keys mean the retry completes the unsent tail without double-sending anyone.",
  },
  {
    q: "Can I schedule in each recipient's timezone?",
    a: "No. sendAt is one absolute instant. Per-user local-time delivery is a journey concern — ctx.when builds the right instant per user.",
  },
  {
    q: "Can Studio create a campaign?",
    a: "No, Studio observes and cancels. Authoring is code or the API — deliberately, so a broadcast is reviewable like any other change.",
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

export default function CampaignsPage(): JSX.Element {
  return (
    <main className="flex flex-1 flex-col">
      <script
        type="application/ld+json"
        // Static literal defined above — no user input flows in.
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD
        dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_JSON_LD) }}
      />

      <CampaignsHero />

      <ProblemStatement label="The problem">
        Not everything is triggered. Journeys cover email that reacts to what a
        user did — sign-up, trial ending, going quiet. A launch, a changelog, a
        pricing change reacts to nothing: it goes to everyone on a list, once,
        at a time you choose. In most stacks that send lives in a dashboard,
        outside the repo that owns the rest of your email. Campaigns put the
        one-off send in the same place as your journeys — code.
      </ProblemStatement>

      <CodeWalkthrough
        eyebrow="Authoring"
        title="A committed file, or one API call"
        subtitle="Both create the same campaign: the same row, the same durable send."
        blocks={[
          {
            filename: "src/campaigns/product-launch.ts",
            code: DEFINE_CAMPAIGN_CODE,
            caption:
              "The worker picks this up on deploy. Edit it while it's still scheduled and the next deploy syncs the change; move sendAt and it reschedules. Once sent, it's retired — redeploys no-op.",
          },
          {
            filename: "anywhere-you-run-typescript.ts",
            code: SDK_SEND_CODE,
            caption:
              "The same thing at runtime — from the SDK, hogsend campaigns send in the CLI, or a plain POST to /v1/campaigns. Agents can drive this too.",
          },
        ]}
      />

      <PointsGrid
        eyebrow="Delivery"
        title="Scheduled, guarded, deduplicated"
        subtitle="Campaign sends go down the same path as journey email: render, preference check, first-party tracking, then the provider wire."
        points={[
          {
            title: "Punctual, with a backstop",
            body: (
              <>
                <code>sendAt</code> becomes a scheduled run in the workflow
                engine. A reaper cron sweeps every five minutes and promotes
                anything due that didn't fire.
              </>
            ),
          },
          {
            title: "No duplicate sends",
            body: "Every recipient send carries an idempotency key. If a crash or retry re-runs the campaign, already-dispatched emails short-circuit and only the unsent tail goes out.",
          },
          {
            title: "Preferences enforced twice",
            body: "Unsubscribed and suppressed contacts are excluded when the audience resolves, and every individual send re-checks before the provider is called.",
          },
          {
            title: "Never a surprise blast",
            body: (
              <>
                A committed campaign whose <code>sendAt</code> is already stale
                on first deploy is marked expired, not sent.
              </>
            ),
          },
          {
            title: "Cancelable until it's done",
            body: "Cancel a scheduled, queued, or in-flight campaign. Mid-send, delivery stops at the next chunk of 100 — dispatched email can't be recalled; the rest is spared.",
          },
          {
            title: "Tracked like everything else",
            body: "Opens and clicks are first-party: rewritten links and the pixel land in your database and PostHog, identical to journey sends, whatever provider is on the wire.",
          },
        ]}
      />

      <ProseSection
        eyebrow="Audience"
        title="A list or a bucket, resolved at send time"
      >
        <code>{'{ list: "product-updates" }'}</code> reaches every subscribed
        member — opt-in lists reach explicit subscribers, opt-out lists reach
        everyone who hasn't left. <code>{'{ bucket: "power-users" }'}</code>{" "}
        reaches whoever is in the behavioral bucket at the moment the campaign
        runs. No CSV uploads, no exported segments going stale.
      </ProseSection>

      <ProseSection
        eyebrow="Studio"
        title="Authored in code, watched in Studio"
      >
        The Campaigns view shows every campaign's status, audience, scheduled
        time, and live progress — sent, skipped, failed. One button cancels
        anything still in flight. Studio can't author campaigns; that stays in
        code, where it can be reviewed.
      </ProseSection>

      <ProseSection
        eyebrow="Coming from Resend Broadcasts"
        title="Broadcasts map one-to-one"
      >
        An Audience becomes a list. A Broadcast becomes a campaign. A scheduled
        broadcast is <code>sendAt</code>, cancelable until it fires. Resend
        stays on as the send wire — same API key, same domains. Hogsend replaces
        the orchestration, not the delivery.
      </ProseSection>

      <UseCaseFaq
        items={FAQ_ITEMS}
        links={[
          { label: "Guide: campaigns", href: "/docs/guides/campaigns" },
          {
            label: "Campaigns API reference",
            href: "/docs/data-api/campaigns",
          },
          {
            label: "Recipe: marketing campaigns",
            href: "/docs/recipes/marketing-campaigns",
          },
          { label: "Guide: lists", href: "/docs/guides/lists" },
        ]}
      />

      <ClosingCta
        title="Send your first campaign"
        subtitle="Scaffold an app with create-hogsend — the template ships with two example campaigns, disabled, ready to point at your list."
      />
    </main>
  );
}
