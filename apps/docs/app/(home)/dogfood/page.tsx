import type { Metadata } from "next";
import Link from "next/link";
import type { JSX, ReactNode } from "react";
import { Button } from "@/components/ds/button";
import { CodeWindow } from "@/components/ds/code-window";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import { GITHUB_URL } from "@/lib/site";

// Bare label — the root layout template appends " — Hogsend".
export const metadata: Metadata = {
  title: "How we run Hogsend on Hogsend",
  description:
    "What we do with our own product: the docs funnel, the course lifecycle, the Discord community, and the referral loop — why each exists, how they fit together, and the code behind them.",
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

const DISCORD_WELCOME_CODE = `// 1) The DM — a PERSONAL tracked link (stitches this member's click to
//    their contact key). \`dmMember\` soft-fails if their DMs are closed.
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
  "Hey — welcome to the Hogsend community, and thanks for verifying! 🎉\\n\\n" +
    \`If you're getting started, here's the quickest path in: \${dmLink.url}\\n\\n\` +
    "Ask anything in the server — we read everything.",
);

// 1b) Drop an in-app notification into their feed — the SAME bell the docs
//     site polls. Linking folded their discord_id + email onto ONE contact,
//     so this lands on the web session they signed up with: a real,
//     cross-channel "your Discord is linked" moment driven by the actual
//     \`/link\` slash command, not a demo button.
await sendFeedItem({
  recipient: { anonymousId: user.id },
  type: "success",
  title: "You linked your Discord 🎉",
  body: "Your Discord is now connected to your Hogsend identity. This reached your bell because linking stitched your web session to your contact — one identity across web and Discord.",
  actionUrl: GETTING_STARTED_URL,
  journeyStateId: user.stateId,
});`;

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

function Prose({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="flex max-w-2xl flex-col gap-5 text-[15px] text-white/65 leading-7">
      {children}
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
              eyebrow="How we use it"
              title="How we run Hogsend on Hogsend"
              subtitle="Hogsend is one business, and it runs its own marketing on one production Hogsend instance. This page walks through what we're actually doing with it — the docs funnel, the course, the Discord community, the referral loop — and the thinking behind each one. Real journeys, real emails, and the occasional bit of real code."
            />
          </Reveal>
          <Reveal
            delay={0.1}
            className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-4"
          >
            <Button href="#aim" variant="accent" icon>
              Start with the why
            </Button>
            <Button href={GITHUB_URL} variant="outline" external>
              The engine, on GitHub
            </Button>
          </Reveal>
        </div>
      </section>

      {/* ---- The aim ----------------------------------------------------- */}
      <Section id="aim">
        <Reveal>
          <SectionHeading
            eyebrow="The aim"
            title="Fix the bucket before paying to fill it"
            subtitle="The strategy behind every loop on this page is the same one the course teaches: paid traffic comes last."
          />
        </Reveal>
        <Reveal delay={0.08} className="mt-10">
          <Prose>
            <p>
              At some point we&rsquo;ll put money behind Hogsend — ads,
              sponsorships, the usual. Paid clicks are also the most expensive
              possible way to find out that people fall through the cracks after
              they arrive. So the work right now is closing the cracks: making
              sure that every way somebody can meet Hogsend, there&rsquo;s a
              next step waiting for them, and a step after that.
            </p>
            <p>
              Read the docs and tap <em>keep me posted</em> — a journey walks
              you toward your first running journey and then checks in on how it
              went. Join the Discord — a journey welcomes you and connects your
              account to your email, so the community isn&rsquo;t a separate
              island of strangers. Buy the course — a set of journeys picks you
              up from the receipt through to finishing, and asks how it landed.
              Tell a friend — a journey notices and says thank you properly.
              Nobody enters and just&hellip; sits there.
            </p>
            <p>
              When the ads eventually switch on, that&rsquo;s what they pour
              into: a bucket that holds water. And because we sell the tool that
              does this, the whole program doubles as proof — it&rsquo;s all one
              standard <InlineCode>create-hogsend</InlineCode> app, a few dozen
              journeys and emails in one TypeScript repo, on the same engine
              you&rsquo;d scaffold today. The four loops below are the ones that
              matter.
            </p>
          </Prose>
        </Reveal>
      </Section>

      {/* ---- Loop 1: the docs funnel ------------------------------------ */}
      <Section id="docs-funnel">
        <Reveal>
          <SectionHeading
            eyebrow="The docs funnel"
            title="Get readers to a running journey"
            subtitle="Most people meet Hogsend through the docs. The aim of the first ten days isn't to sell anything — it's to get you to a journey running in your own repo, because that's the moment this stops being a docs site you read and starts being a tool you use."
          />
        </Reveal>
        <div className="mt-12 grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
          <Reveal>
            <Prose>
              <p>
                Subscribing starts a six-email series over ten days that walks
                the same path the docs do — why lifecycle, the recipes, the
                agents, the community. Then, on day ten, we just ask:{" "}
                <em>&ldquo;Did you get a journey running?&rdquo;</em> The yes/no
                buttons in that email <em>are</em> the answer — a tap flows back
                into the journey as an event, and the code on the right picks it
                up and decides what happens next.
              </p>
              <p>
                Say <em>yes</em> and a couple of days later we ask a small
                favour — that&rsquo;s the referral loop further down. Say{" "}
                <em>no</em> and we offer actual help: the setup week, a human
                installing it with you. Say nothing, and we look at what you did
                instead — if you clicked deploy since the check-in went out, you
                clearly got moving on your own, so the offer is withdrawn and we
                ask the favour instead.
              </p>
              <p>
                Two details we care about. The offer journey exits the moment
                you click deploy, even mid-conversation — nobody should be
                pitched help they&rsquo;ve stopped needing. And a genuine{" "}
                <em>interested</em> doesn&rsquo;t become a row in a CRM; it
                becomes an email in Doug&rsquo;s inbox.
              </p>
            </Prose>
          </Reveal>
          <Reveal delay={0.1}>
            <CodeWindow
              filename="src/journeys/docs-subscriber.ts (trimmed)"
              code={DOCS_CHECKIN_CODE}
            />
          </Reveal>
        </div>
      </Section>

      {/* ---- Loop 2: the course ------------------------------------------ */}
      <Section id="course">
        <Reveal>
          <SectionHeading
            eyebrow="The course"
            title="The course runs on what it teaches"
            subtitle="The course teaches lifecycle marketing on PostHog and Hogsend — so buying it enrolls you in exactly the kind of program the chapters describe. If our own course didn't nurture properly, why would you believe the chapters?"
          />
        </Reveal>
        <div className="mt-12 grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
          <Reveal>
            <Prose>
              <p>
                A purchase kicks off several journeys at once, each with one
                job: the receipt lands immediately, a walkthrough gets you into
                chapter one, the next day comes the community invite, Discord
                access unlocks if your account is linked, and your share code is
                issued. Splitting them means a second purchase still gets its
                receipt while the walkthrough carries on undisturbed.
              </p>
              <p>
                The walkthrough is the part we sweat. It watches for three days
                for your first completed chapter. If you never start, you get
                one honest nudge, one more watch — and then silence. Nurture
                isn&rsquo;t nagging; someone who bought and didn&rsquo;t start
                doesn&rsquo;t need a fourth email, they need the next real
                reason to open the thing.
              </p>
              <p>
                And when you finish, we wait two days and ask the 0&ndash;10
                question. The in-app card gets first go; the email is the
                fallback; both feed one score stream. Promoters get a small
                testimonial ask. Detractors get Doug, personally — a flag in his
                inbox, not an automated apology. Finish a second course within
                six months and you won&rsquo;t be surveyed again.
              </p>
            </Prose>
          </Reveal>
          <Reveal delay={0.1}>
            <CodeWindow
              filename="src/journeys/course-feedback.ts (trimmed)"
              code={COURSE_NPS_CODE}
            />
          </Reveal>
        </div>
      </Section>

      {/* ---- Loop 3: referrals ------------------------------------------- */}
      <Section id="referrals">
        <Reveal>
          <SectionHeading
            eyebrow="Referrals"
            title="Ask the favour when it's earned"
            subtitle="Referrals only work when you ask people who are already winning — which is why the ask lives at the end of the docs funnel's happy path, not in a banner. The other half is making sure the credit lands reliably enough that the favour feels worth doing."
          />
        </Reveal>
        <div className="mt-12 grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
          <Reveal>
            <Prose>
              <p>
                A friend visits through your link and that visit is remembered
                against them. The conversion moment is deliberately strict:
                it&rsquo;s when they verify in the Discord — the point where an
                anonymous visitor becomes a real, reachable person. That&rsquo;s
                when the journey on the right runs: it reads the attributing
                visit back out of their history, and credits <em>you</em> from
                inside <em>their</em> journey.
              </p>
              <p>
                There&rsquo;s no codes table and no ledger to reconcile — the
                events are the ledger, and the attribution survives the moment
                the anonymous visitor and the verified member get folded into
                one identity. Each credit thanks you with a DM and an email, and
                crossing the milestone grants the 🏅 Ambassador role in the
                server — once, ever, no matter how many times you cross it.
              </p>
            </Prose>
          </Reveal>
          <Reveal delay={0.1}>
            <CodeWindow
              filename="src/journeys/referral-convert.ts (trimmed)"
              code={REFERRAL_CONVERT_CODE}
            />
          </Reveal>
        </div>
      </Section>

      {/* ---- Loop 4: the Discord community -------------------------------- */}
      <Section id="discord">
        <Reveal>
          <SectionHeading
            eyebrow="The Discord community"
            title="One identity across web, email, and Discord"
            subtitle="Communities usually sit on an island: the person in your server and the person on your list are two strangers who happen to be the same human. The /link command is how we join them — and most of the loops above only work because of it."
          />
        </Reveal>
        <div className="mt-12 grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
          <Reveal>
            <Prose>
              <p>
                Verify in the server and a welcome journey greets you twice: a
                DM with a personal getting-started link, and — because linking
                just connected your Discord to your email — a notification in
                the same in-app bell you&rsquo;d see on the docs site. That
                second one is the quiet proof of the whole model: something you
                did in Discord showing up on your web session, because both now
                belong to one contact.
              </p>
              <p>
                From there the graph does the work. Course buyers with a linked
                account get the private channel and the 🎓 role without asking.
                Referral credits fire off the verification moment. And a re-link
                never re-greets — the journey runs once per person, full stop.
              </p>
            </Prose>
          </Reveal>
          <Reveal delay={0.1}>
            <CodeWindow
              filename="src/journeys/discord-welcome.ts (trimmed)"
              code={DISCORD_WELCOME_CODE}
            />
          </Reveal>
        </div>
      </Section>

      {/* ---- Why run it this way ------------------------------------------ */}
      <Section id="why">
        <Reveal>
          <SectionHeading
            eyebrow="Why bother"
            title="The loops are also the test suite"
            subtitle="Running the business on the engine means every feature gets used in anger on real customers — ours — before it ships to you."
          />
        </Reveal>
        <Reveal delay={0.08} className="mt-10">
          <Prose>
            <p>
              When something is awkward to author, we feel it before you do.
              Several engine features — the <InlineCode>where</InlineCode>{" "}
              condition builder, wait <InlineCode>lookback</InlineCode>,
              replay-safe auto-keying — exist because one of the loops on this
              page needed them. That&rsquo;s the other half of why we run it
              this way: the nurture program and the product roadmap are the same
              feedback loop.
            </p>
          </Prose>
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
              subtitle="The course lifecycle has its own journey-by-journey walkthrough in the docs, and everything on this page runs on the same code create-hogsend scaffolds — source-available, on GitHub."
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
