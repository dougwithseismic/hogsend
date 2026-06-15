import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { CodeMock } from "@/components/ds/mockup";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";

/**
 * InTheLoop — the run-time agent story (distinct from the author-time
 * "Agent-native" section lower down). A journey parks on ctx.waitForEvent and
 * resumes on a plain event; that event can be fired by a person approving a
 * send or by an agent returning a verdict. Both cards show the SAME
 * waitForEvent shape so the "one primitive, two producers" point is visible.
 * Snippets are faithful to the human-approval-gate / agent-feedback-loop
 * recipes.
 */

const HUMAN_LINES: Parameters<typeof CodeMock>[0]["lines"] = [
  {
    text: "// ask a person, then park the run until they answer",
    tone: "comment",
  },
  {
    text: "await ctx.trigger({ event: Events.APPROVAL_REQUESTED });",
    tone: "plain",
  },
  { text: "", tone: "plain" },
  { text: "const approval = await ctx.waitForEvent({", tone: "keyword" },
  { text: "  event: Events.APPROVAL_GRANTED,", tone: "string" },
  { text: "  timeout: days(2),", tone: "plain" },
  { text: "});", tone: "keyword" },
  { text: "", tone: "plain" },
  {
    text: "// silence fails safe → the pre-approved fallback",
    tone: "comment",
  },
  { text: "if (approval.timedOut) {", tone: "keyword" },
  {
    text: "  return sendEmail({ template: Templates.WINBACK_STANDARD });",
    tone: "plain",
  },
  { text: "}", tone: "keyword" },
  {
    text: "sendEmail({ template: Templates.WINBACK_DISCOUNT_OFFER });",
    tone: "plain",
  },
];

const AGENT_LINES: Parameters<typeof CodeMock>[0]["lines"] = [
  {
    text: "// the answer's gone to your agent — wait for its verdict",
    tone: "comment",
  },
  { text: "const verdict = await ctx.waitForEvent({", tone: "keyword" },
  { text: "  event: Events.CHURN_FOLLOWUP_SELECTED,", tone: "string" },
  { text: "  timeout: hours(6),", tone: "plain" },
  { text: "  lookback: minutes(30),", tone: "plain" },
  { text: "});", tone: "keyword" },
  { text: "", tone: "plain" },
  { text: 'const action = verdict.timedOut ? "none"', tone: "plain" },
  { text: "  : String(verdict.properties?.action);", tone: "plain" },
  { text: "", tone: "plain" },
  { text: "// branch on what the agent decided", tone: "comment" },
  { text: 'if (action === "offer") {', tone: "keyword" },
  {
    text: "  sendEmail({ template: Templates.FEEDBACK_SAVE_OFFER });",
    tone: "plain",
  },
  { text: "}", tone: "keyword" },
];

function CardLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="group inline-flex items-center gap-1.5 text-sm text-white/70 transition-colors hover:text-white"
    >
      <span>{children}</span>
      <ArrowRight
        aria-hidden="true"
        className="size-3.5 transition-transform duration-200 group-hover:translate-x-0.5"
        strokeWidth={1.5}
      />
    </Link>
  );
}

const CARDS = [
  {
    eyebrow: "Human in the loop",
    title: "A person approves before it sends",
    body: "ctx.trigger asks, ctx.waitForEvent parks the run for up to two days, and an operator fires approval.granted from any tool that can POST an event. Silence sends the pre-approved fallback — a missed approval downgrades the offer, it never escalates it.",
    lines: HUMAN_LINES,
    filename: "src/journeys/human-approval-gate.ts",
    link: {
      label: "Human-approval gate recipe",
      href: "/docs/recipes/human-approval-gate",
    },
  },
  {
    eyebrow: "Agent in the loop",
    title: "An agent decides the next step",
    body: "A confirmed email answer fans out to your agent over a signed webhook. The agent fires its verdict back as one event, and the journey — still parked on the same wait — branches on it. The agent is just another producer on the event stream your app already uses.",
    lines: AGENT_LINES,
    filename: "src/journeys/exit-interview.ts",
    link: {
      label: "Agent feedback-loop recipe",
      href: "/docs/recipes/agent-feedback-loop",
    },
  },
];

/**
 * "Human and agent in the loop" — a two-up section showing a journey that
 * pauses on a durable wait and resumes when a person or an agent fires the
 * event it needs.
 */
export function InTheLoop({ className }: { className?: string }) {
  return (
    <Section id="in-the-loop" className={className}>
      <Reveal>
        <SectionHeading
          eyebrow="Human and agent in the loop"
          title="Pause a journey for a person — or an agent"
          subtitle="ctx.waitForEvent parks the run durably until the event it needs is fired — by an operator approving a discount, or by an agent deciding the next step. The journey branches on the verdict either way, and an unanswered wait times out to a safe default."
        />
      </Reveal>

      <div className="mt-12 grid grid-cols-1 gap-6 md:mt-16 lg:grid-cols-2">
        {CARDS.map((card, index) => (
          <Reveal key={card.title} delay={index * 0.08}>
            <Card className="flex h-full flex-col gap-5 p-0">
              <div className="border-white/[0.08] border-b p-5">
                <CodeMock filename={card.filename} lines={card.lines} />
              </div>
              <div className="flex flex-1 flex-col gap-2.5 px-6 pb-6">
                <span className="font-medium text-accent text-sm tracking-[-0.01em]">
                  {card.eyebrow}
                </span>
                <h3 className="font-medium font-sans text-white text-xl leading-[1.2] tracking-[-0.02em]">
                  {card.title}
                </h3>
                <p className="text-base text-white/60 leading-6">{card.body}</p>
                <div className="mt-auto pt-3">
                  <CardLink href={card.link.href}>{card.link.label}</CardLink>
                </div>
              </div>
            </Card>
          </Reveal>
        ))}
      </div>

      <Reveal delay={0.1} className="mt-10">
        <p className="text-base text-white/60 leading-6">
          Same primitive both times: a durable wait that resumes on a plain
          event, whoever fires it.
        </p>
      </Reveal>

      <Reveal delay={0.16} className="mt-6">
        <Button href="/recipes" variant="outline" icon>
          Browse the in-the-loop recipes
        </Button>
      </Reveal>
    </Section>
  );
}
