import type { Metadata } from "next";
import Link from "next/link";
import type { JSX, ReactNode } from "react";
import { TagPill } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { CodeWindow } from "@/components/ds/code-window";
import { Stat } from "@/components/ds/decor";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import { GITHUB_URL } from "@/lib/site";

// Bare label — the root layout template appends " — Hogsend".
export const metadata: Metadata = {
  title: "How we run Hogsend on Hogsend",
  description:
    "The vendor's own production instance, torn down: 45 journeys, 39 email templates, a Discord connector, and a referral program — the docs funnel, the course lifecycle, and the community, all running on the engine we ship.",
};

/* ------------------------------------------------------------------------ */
/*  Code excerpts — real files from the production instance, trimmed.       */
/*  Source of truth: the hogsend-dogfood app this page describes.           */
/* ------------------------------------------------------------------------ */

const DOCS_CHECKIN_CODE = `// The one-tap check-in: the yes/no buttons are semantic links — a
// click fires \`docs.checkin.answered { answer }\` through the full
// pipeline, and the wait below resumes with the answer's payload.
const checkin = await ctx.waitForEvent({
  event: Events.DOCS_CHECKIN_ANSWERED,
  timeout: days(5),
  label: "await-checkin",
});

const answer = checkin.timedOut ? undefined : checkin.properties?.answer;

if (answer === "yes") {
  // Activated — a couple of days from now, the referral favour.
  await ctx.trigger({
    event: Events.DOCS_REFERRAL_ELIGIBLE,
    userId: user.id,
    properties: { reason: "activated", source: "docs-checkin" },
  });
  return;
}

if (answer === "no") {
  // Struggler — the setup-week offer path.
  await ctx.trigger({
    event: Events.DOCS_SETUP_ELIGIBLE,
    userId: user.id,
    properties: { reason: "needs-help", source: "docs-checkin" },
  });
  return;
}

// Silent (timed out). A deploy click since the check-in went out means
// they got moving on their own — withdraw the pitch, ask the favour
// instead.
const { found: deployedSinceCheckin } = await ctx.history.hasEvent({
  userId: user.id,
  event: Events.DOCS_DEPLOY_CLICKED,
  within: days(6),
});`;

const SETUP_OFFER_META_CODE = `meta: {
  id: "docs-setup-offer",
  trigger: { event: Events.DOCS_SETUP_ELIGIBLE },
  entryLimit: "once",
  suppress: hours(12),
  // A deploy click at ANY point exits the offer mid-wait — they're
  // moving on their own and the pitch is withdrawn.
  exitOn: [{ event: Events.DOCS_DEPLOY_CLICKED }],
},`;

const COURSE_NPS_CODE = `// The click IS the answer (the 0–10 EmailActions emit
// course.nps_submitted). Lookback covers a tap that lands between the
// send and this wait being established.
const answer = await ctx.waitForEvent({
  event: Events.COURSE_NPS_SUBMITTED,
  timeout: days(10),
  lookback: minutes(30),
  label: "await-nps",
});
if (answer.timedOut) return;

const score = num(answer.properties?.score);
if (score === undefined) return;

if (score >= 9) {
  // Promoter → the testimonial ask.
  if (!(await ctx.guard.isSubscribed())) return;
  await sendEmail({
    to: user.email,
    userId: user.id,
    journeyStateId: user.stateId,
    template: Templates.COURSE_TESTIMONIAL_ASK,
    subject: "Thank you — one small ask",
    journeyName: user.journeyName,
    props: { name: firstName ?? "there", score, courseTitle },
  });
} else if (score <= 6) {
  // Detractor → Doug, personally, not an automated apology.
  await ctx.trigger({
    event: Events.COURSE_LEAD_FLAGGED,
    userId: user.id,
    properties: { reason: "course-detractor", answer: String(score) },
  });
}`;

const REFERRAL_CONVERT_CODE = `run: async (user, ctx) => {
  // The visit that attributed this person to a referrer, within the
  // window.
  const visits = await ctx.history.events({
    userId: user.id,
    event: Events.REFERRAL_VISITED,
    within: days(Referral.ATTRIBUTION_WINDOW_DAYS),
    limit: 10,
  });
  const referrerKey = visits
    .map((e) => e.properties?.referred_by)
    .find((k): k is string => typeof k === "string" && k.length > 0);

  // No attribution, or a self-referral (the identity merge collapsed
  // referrer and referee onto one contact) — nothing to credit.
  if (!referrerKey || referrerKey === user.id) return;
  await ctx.checkpoint("attributed");

  // Cross-person hop: enroll the REFERRER in the reward journey. The
  // engine auto-keys ctx.trigger, so this is exactly-once across a
  // replay.
  await ctx.trigger({
    event: Events.REFERRAL_CREDITED,
    userId: referrerKey,
    properties: { refereeId: user.id },
  });
},`;

const DISCORD_WELCOME_CODE = `// 1) The DM — a PERSONAL tracked link (stitches this member's click
//    to their contact key). \`dmMember\` soft-fails if DMs are closed.
const dmLink = await mintLink({
  db,
  url: GETTING_STARTED_URL,
  baseUrl: API_PUBLIC_URL,
  source: "discord",
  type: "personal",
  distinctId: user.id,
  label: "Discord welcome DM",
  campaign: "discord-welcome",
});
await dmMember(
  discordId,
  "Hey — welcome to the Hogsend community, and thanks for " +
    \`verifying! Here's the quickest path in: \${dmLink.url}\`,
);

// 1b) Drop an in-app notification into their feed — the SAME bell the
//     docs site polls. Linking folded their discord_id + email onto
//     ONE contact, so this lands on the web session they signed up
//     with.
await sendFeedItem({
  recipient: { anonymousId: user.id },
  type: "success",
  title: "You linked your Discord 🎉",
  body: "Your Discord is now connected to your Hogsend identity.",
  actionUrl: GETTING_STARTED_URL,
  journeyStateId: user.stateId,
});`;

/* ------------------------------------------------------------------------ */
/*  Copy data                                                                */
/* ------------------------------------------------------------------------ */

const EXERCISES: Array<{ token: string; body: string }> = [
  {
    token: "ctx.waitForEvent",
    body: "Every “did they respond?” on this page is a durable wait — the docs check-in, both setup-offer answers, the first-chapter watch, the NPS score. The answer arrives in the wait's payload; the branch is plain TypeScript.",
  },
  {
    token: "semantic links",
    body: "The yes/no and 0–10 buttons in our emails are EmailAction links. A click fires the consumer event (docs.checkin.answered, course.nps_submitted) through the full pipeline, confirmed after the scanner burst window so a link-scanning bot never answers a survey.",
  },
  {
    token: "durable sleeps",
    body: "The six-email docs series and the day-one breathers park in Hatchet with ctx.sleep. A deploy or worker restart resumes them; nobody is dropped three days into a sequence.",
  },
  {
    token: "exitOn",
    body: "A docs.deploy_clicked event cancels the setup-week pitch mid-wait; course.purchased exits the convert nudges the same way. The journey never pitches someone who already moved.",
  },
  {
    token: "entryLimit + suppress",
    body: "“once” on greetings and offers, “unlimited” where re-entry is the point (referral credits, milestones), “once_per_period” on the NPS so a second course finished within 180 days isn't re-surveyed. suppress absorbs webhook storms.",
  },
  {
    token: "ctx.trigger",
    body: "Cross-journey routing (check-in → referral ask or setup offer), cross-person hops (crediting the referrer from the referee's journey), and operator flags (docs.lead.flagged, course.lead.flagged) are all real ingested events any journey can trigger on.",
  },
  {
    token: "ctx.history + markers",
    body: "Attribution lookups, purchase checks, and exactly-once role grants all read the event history. The Ambassador and 🎓 Student roles are deduped by marker events, so unlimited re-enrollment never re-grants.",
  },
  {
    token: "cold-connect identity",
    body: "The Discord /link handshake folds a member's discord_id and email onto one contact. That single fold is what makes the referral conversion, the #course access conjunction, and the cross-channel feed item possible.",
  },
  {
    token: "mintLink + the feed",
    body: "The welcome DM carries a personal tracked link and the #welcome post a public campaign link — first-party link tracking on a non-email channel. sendFeedItem drops the same lifecycle into the in-app bell the docs site polls.",
  },
  {
    token: "connector actions + custom tasks",
    body: "Journeys call the Discord connector directly — grantRole, DMs, channel posts. The notify-lead Hatchet task emails Doug outside any journey's exitOn scope, and a custom outbound destination fans events into the Discord server.",
  },
];

/* ------------------------------------------------------------------------ */
/*  Primitives                                                               */
/* ------------------------------------------------------------------------ */

function InlineCode({ children }: { children: ReactNode }): JSX.Element {
  return (
    <code className="rounded bg-white/[0.08] px-1.5 py-0.5 font-mono text-[13px] text-white/90">
      {children}
    </code>
  );
}

function FactList({ items }: { items: ReactNode[] }): JSX.Element {
  return (
    <ul className="flex flex-col gap-3">
      {items.map((item, index) => (
        // Static copy list — index keys are fine.
        // biome-ignore lint/suspicious/noArrayIndexKey: static content
        <li key={index} className="flex gap-3 text-[15px] leading-6">
          <span aria-hidden className="mt-[9px] h-px w-4 shrink-0 bg-accent" />
          <span className="text-white/60">{item}</span>
        </li>
      ))}
    </ul>
  );
}

function PrimitivePills({ pills }: { pills: string[] }): JSX.Element {
  return (
    <div className="mt-6 flex flex-wrap gap-2">
      {pills.map((pill) => (
        <TagPill key={pill} className="font-mono">
          {pill}
        </TagPill>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/*  Page                                                                     */
/* ------------------------------------------------------------------------ */

export default function DogfoodPage(): JSX.Element {
  return (
    <main className="flex flex-1 flex-col">
      {/* ---- Hero ------------------------------------------------------ */}
      <section className="relative overflow-hidden text-white">
        <div className="container-page pt-32 pb-20">
          <Reveal>
            <SectionHeading
              eyebrow="Receipts"
              title="How we run Hogsend on Hogsend"
              subtitle="Hogsend is one business running one production Hogsend instance, at t.hogsend.com. The docs-site lifecycle, the paid course, the Discord community, and the referral program are all defineJourney() calls in one TypeScript repo — a standard create-hogsend app on the same engine you'd scaffold. This page tears the real loops down, with the real code."
            />
          </Reveal>
          <Reveal
            delay={0.1}
            className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-4"
          >
            <Button href="#loops" variant="accent" icon>
              See the loops
            </Button>
            <Button href={GITHUB_URL} variant="outline" external>
              The engine, on GitHub
            </Button>
          </Reveal>
        </div>
      </section>

      {/* ---- The instance at a glance ----------------------------------- */}
      <Section id="glance">
        <Reveal>
          <SectionHeading
            eyebrow="The instance at a glance"
            title="Counts from the source, not a dashboard"
            subtitle="Every number below is a count of code in the instance's repo — journey definitions, template registry keys, registered sources — not an analytics screenshot."
          />
        </Reveal>
        <Reveal delay={0.08} className="mt-12">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-10 md:grid-cols-4">
            <Stat value="45" label="Journeys registered" />
            <Stat value="39" label="Email templates" />
            <Stat value="2" label="Custom webhook sources" />
            <Stat value="1" label="Discord connector" />
          </dl>
        </Reveal>
        <Reveal delay={0.14} className="mt-10 max-w-2xl">
          <p className="text-[15px] text-white/60 leading-6">
            Plus one custom outbound destination (Discord) and two custom
            Hatchet workflows — a lead-alert task and a backfill job. Twenty of
            the forty-five journeys run the course lifecycle, seven run the
            Discord community roles, and the rest cover the docs funnel, the
            in-app demo, and referrals. The instance publishes its own health —
            database, Redis, worker heartbeat, and last-24-hour send and journey
            counters — publicly at{" "}
            <a
              href="https://t.hogsend.com/v1/health"
              target="_blank"
              rel="noreferrer"
              className="text-white/80 underline-offset-2 hover:text-white hover:underline"
            >
              t.hogsend.com/v1/health
            </a>
            .
          </p>
        </Reveal>
      </Section>

      {/* ---- Loop 1: the docs funnel ------------------------------------ */}
      <Section id="loops">
        <Reveal>
          <SectionHeading
            eyebrow="Loop 1 — the docs funnel"
            title="A subscriber, a check-in, and two exits"
            subtitle="The docs site's keep-me-posted form fires docs.subscribed, which enrolls a six-email series over ten days: welcome, why lifecycle, recipes, agents, the Discord, and — on day ten — a one-tap check-in that decides what happens next."
          />
        </Reveal>
        <div className="mt-12 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
          <Reveal>
            <div className="flex flex-col gap-8">
              <FactList
                items={[
                  <>
                    The check-in email asks{" "}
                    <em>&ldquo;Did you get a journey running?&rdquo;</em> with
                    yes/no semantic-link buttons. The click is the answer —{" "}
                    <InlineCode>ctx.waitForEvent</InlineCode> resumes with its
                    payload.
                  </>,
                  <>
                    &ldquo;Yes&rdquo; routes into the referral ask;
                    &ldquo;no&rdquo; routes into the setup-week offer; silence
                    checks <InlineCode>ctx.history</InlineCode> for a deploy
                    click and picks accordingly. All three routes are{" "}
                    <InlineCode>ctx.trigger</InlineCode> events, so the
                    follow-on journeys re-check preferences at enrollment.
                  </>,
                  <>
                    The follow-on offer journey carries{" "}
                    <InlineCode>exitOn: docs.deploy_clicked</InlineCode> — a
                    deploy click at any point cancels the pitch mid-wait.
                  </>,
                  <>
                    A confirmed &ldquo;interested&rdquo; fires{" "}
                    <InlineCode>docs.lead.flagged</InlineCode>, which the custom{" "}
                    <InlineCode>notify-lead</InlineCode> Hatchet task turns into
                    an alert email to Doug — outside any journey&rsquo;s{" "}
                    <InlineCode>exitOn</InlineCode> scope.
                  </>,
                ]}
              />
              <CodeWindow
                filename="src/journeys/docs-setup-offer.ts (meta, trimmed)"
                code={SETUP_OFFER_META_CODE}
              />
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <CodeWindow
              filename="src/journeys/docs-subscriber.ts (trimmed)"
              code={DOCS_CHECKIN_CODE}
            />
            <PrimitivePills
              pills={[
                "ctx.waitForEvent",
                "semantic links",
                "ctx.trigger",
                "ctx.history.hasEvent",
                "exitOn",
              ]}
            />
          </Reveal>
        </div>
      </Section>

      {/* ---- Loop 2: the course ------------------------------------------ */}
      <Section id="course">
        <Reveal>
          <SectionHeading
            eyebrow="Loop 2 — the course"
            title="One purchase event, five journeys"
            subtitle="A course purchase fires course.purchased, and five journeys enroll on it at once: the receipt welcome, the onboarding walkthrough, the day-two community invite, the Discord access grant, and the share-code issuer. Each owns one job."
          />
        </Reveal>
        <div className="mt-12 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
          <Reveal>
            <FactList
              items={[
                <>
                  The welcome is{" "}
                  <InlineCode>entryLimit: &quot;unlimited&quot;</InlineCode> so
                  a second SKU still gets its receipt; the walkthrough is{" "}
                  <InlineCode>&quot;once&quot;</InlineCode> per reader. Split on
                  purpose — the walkthrough holds an active state for days and
                  would otherwise swallow a later purchase&rsquo;s welcome.
                </>,
                <>
                  The walkthrough watches three days for a first completed
                  chapter (<InlineCode>ctx.waitForEvent</InlineCode> with a
                  lookback covering the webhook-to-wait gap). A buyer who never
                  starts gets one honest nudge, one more watch, then silence.
                </>,
                <>
                  On <InlineCode>course.completed</InlineCode>, the NPS email
                  waits two days first — the in-app card gets first go, and both
                  surfaces emit the same{" "}
                  <InlineCode>course.nps_submitted</InlineCode> event, so the
                  score stream is one stream.
                </>,
                <>
                  The journey branches on the awaited score: promoters
                  (9&ndash;10) get the testimonial ask, detractors (0&ndash;6)
                  flag Doug personally via{" "}
                  <InlineCode>course.lead.flagged</InlineCode>.{" "}
                  <InlineCode>
                    entryLimit: &quot;once_per_period&quot;
                  </InlineCode>{" "}
                  (180 days) means finishing a second course isn&rsquo;t
                  re-surveyed.
                </>,
                <>
                  Access to the private #course channel is the conjunction of
                  two facts the engine already holds — a purchase on the contact
                  and a linked <InlineCode>discord_id</InlineCode>. Two journeys
                  cover both orders of arrival, and a marker event makes the 🎓
                  role grant exactly-once.
                </>,
              ]}
            />
          </Reveal>
          <Reveal delay={0.1}>
            <CodeWindow
              filename="src/journeys/course-feedback.ts (trimmed)"
              code={COURSE_NPS_CODE}
            />
            <PrimitivePills
              pills={[
                "ctx.waitForEvent + lookback",
                "entryLimit: once_per_period",
                "semantic links",
                "connector actions",
                "marker events",
              ]}
            />
          </Reveal>
        </div>
      </Section>

      {/* ---- Loop 3: referrals ------------------------------------------- */}
      <Section id="referrals">
        <Reveal>
          <SectionHeading
            eyebrow="Loop 3 — referrals"
            title="Attribution without a ledger table"
            subtitle="A visit through someone's ?ref= link lands as referral.visited on the visitor, via a custom webhook source. The qualifying conversion is the Discord /link handshake — the exact moment an anonymous referee becomes an email-identified contact."
          />
        </Reveal>
        <div className="mt-12 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
          <Reveal>
            <FactList
              items={[
                <>
                  <InlineCode>referral-convert</InlineCode> reads the
                  attributing visit back from the referee&rsquo;s own event
                  history — attribution survives the identity merge that folds
                  the anonymous visitor onto the signed-up person, because
                  history re-points to the surviving contact.
                </>,
                <>
                  There is no referral-codes table and no ledger.{" "}
                  <InlineCode>entryLimit: &quot;once&quot;</InlineCode> makes a
                  referee credit at most once, ever; the reward side is deduped
                  by a marker event.
                </>,
                <>
                  The credit is a cross-person hop:{" "}
                  <InlineCode>ctx.trigger</InlineCode> enrolls the{" "}
                  <em>referrer</em> in <InlineCode>referral-reward</InlineCode>{" "}
                  from inside the referee&rsquo;s journey.
                </>,
                <>
                  <InlineCode>referral-reward</InlineCode> is{" "}
                  <InlineCode>entryLimit: &quot;unlimited&quot;</InlineCode> —
                  every conversion re-enrolls and re-counts. Each one pays a
                  Discord DM and an email; crossing the milestone grants the 🏅
                  Ambassador role exactly once, marker-guarded.
                </>,
              ]}
            />
          </Reveal>
          <Reveal delay={0.1}>
            <CodeWindow
              filename="src/journeys/referral-convert.ts (trimmed)"
              code={REFERRAL_CONVERT_CODE}
            />
            <PrimitivePills
              pills={[
                "ctx.history.events",
                "cross-person ctx.trigger",
                "entryLimit: once",
                "identity merge",
                "webhook source",
              ]}
            />
          </Reveal>
        </div>
      </Section>

      {/* ---- Loop 4: the Discord community -------------------------------- */}
      <Section id="discord">
        <Reveal>
          <SectionHeading
            eyebrow="Loop 4 — the Discord community"
            title="One /link, four journeys"
            subtitle="Running /link in the community server binds a member's Discord account to their email contact — the cold-connect handshake. The resulting discord.linked event enrolls four journeys at once: the welcome, the role ladder, the referral conversion above, and the course-access check."
          />
        </Reveal>
        <div className="mt-12 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
          <Reveal>
            <FactList
              items={[
                <>
                  The welcome DM carries a <em>personal</em> tracked link minted
                  with <InlineCode>mintLink</InlineCode> — a click stitches that
                  member&rsquo;s web session to their contact. The public
                  #welcome post gets a separate <em>campaign</em> link that
                  attributes by campaign only.
                </>,
                <>
                  The same journey drops a feed item into the in-app bell the
                  docs site polls — linking folded the member&rsquo;s{" "}
                  <InlineCode>discord_id</InlineCode> and email onto one
                  contact, so the notification lands on the web session they
                  signed up with.
                </>,
                <>
                  <InlineCode>entryLimit: &quot;once&quot;</InlineCode> plus a
                  one-day <InlineCode>suppress</InlineCode> window means a
                  re-link never re-greets.
                </>,
                <>
                  Both outbound actions — the DM and the channel post — are
                  journey-callable Discord connector actions, and both soft-fail
                  (closed DMs, unset channel id) rather than crash the run.
                </>,
              ]}
            />
          </Reveal>
          <Reveal delay={0.1}>
            <CodeWindow
              filename="src/journeys/discord-welcome.ts (trimmed)"
              code={DISCORD_WELCOME_CODE}
            />
            <PrimitivePills
              pills={[
                "cold-connect /link",
                "mintLink",
                "sendFeedItem",
                "connector actions",
                "entryLimit + suppress",
              ]}
            />
          </Reveal>
        </div>
      </Section>

      {/* ---- What this exercises ------------------------------------------ */}
      <Section id="exercises">
        <Reveal>
          <SectionHeading
            eyebrow="What this exercises"
            title="The loops above are the engine's test suite"
            subtitle="Running the business on the engine means every primitive gets used in anger before it ships to you. Each card names the feature and where the loops above lean on it."
          />
        </Reveal>
        <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-2">
          {EXERCISES.map((item, index) => (
            <Reveal key={item.token} delay={(index % 2) * 0.05}>
              <Card>
                <InlineCode>{item.token}</InlineCode>
                <p className="mt-3 text-[15px] text-white/60 leading-6">
                  {item.body}
                </p>
              </Card>
            </Reveal>
          ))}
        </div>
        <Reveal delay={0.15} className="mt-10 max-w-2xl">
          <p className="text-[15px] text-white/55 leading-6">
            When something is awkward to author, we feel it before you do.
            Several engine features — the <InlineCode>where</InlineCode>{" "}
            condition builder, wait <InlineCode>lookback</InlineCode>,
            replay-safe auto-keying — exist because these loops needed them.
          </p>
        </Reveal>
      </Section>

      {/* ---- Closing ------------------------------------------------------ */}
      <Section id="next">
        <div className="mx-auto flex max-w-2xl flex-col items-center text-center">
          <Reveal>
            <SectionHeading
              align="center"
              eyebrow="Go deeper"
              title="Read the loops, then run your own"
              subtitle="The course lifecycle has its own journey-by-journey teardown in the docs. The engine everything on this page runs on is the same code create-hogsend scaffolds — source-available, on GitHub."
            />
          </Reveal>
          <Reveal
            delay={0.1}
            className="mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-4"
          >
            <Button href="/docs/dogfooding" variant="accent" icon>
              The course-loop deep dive
            </Button>
            <Button href={GITHUB_URL} variant="outline" external>
              Source on GitHub
            </Button>
          </Reveal>
          <Reveal delay={0.16}>
            <p className="mt-6 text-sm text-white/50">
              Hogsend is free to self-host —{" "}
              <Link
                href="/pricing"
                className="text-white/70 underline-offset-2 transition-colors hover:text-white hover:underline"
              >
                pricing
              </Link>{" "}
              covers what you actually pay for.
            </p>
          </Reveal>
        </div>
      </Section>
    </main>
  );
}
