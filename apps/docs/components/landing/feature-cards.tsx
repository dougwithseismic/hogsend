import { ArrowRight } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { Card } from "@/components/ds/card";
import { ChatDemo, CodeMock } from "@/components/ds/mockup";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import { cn } from "@/lib/cn";
import studioOverview from "@/public/images/studio/studio-overview.png";

/**
 * FeatureCards — crimzon 3-up feature cards: imagery floating over a red
 * atmospheric gradient up top, title + body below. The agent-native card
 * carries the looping ChatDemo (accurate to the real API — no invented
 * artifacts); the Studio card uses a real product screenshot.
 */

const JOURNEY_LINES: Parameters<typeof CodeMock>[0]["lines"] = [
  { text: "export const winback = defineJourney({", tone: "keyword" },
  { text: "  meta: {", tone: "plain" },
  { text: '    id: "winback",', tone: "string" },
  { text: "    trigger: { event: wentDormant.entered },", tone: "plain" },
  { text: "    exitOn: [{ event: wentDormant.left }],", tone: "plain" },
  { text: "  },", tone: "plain" },
  { text: "  run: async (user, ctx) => {", tone: "keyword" },
  { text: "    await sendEmail({ /* check-in */ });", tone: "comment" },
  { text: "    await ctx.sleep({ duration: days(7) });", tone: "plain" },
  { text: "    await sendEmail({ /* final nudge */ });", tone: "comment" },
  { text: "  },", tone: "plain" },
  { text: "});", tone: "keyword" },
];

const CHAT_MESSAGES = [
  {
    from: "user" as const,
    text: "Add a win-back journey — when someone enters the went-dormant bucket, send a check-in, wait 7 days, then a final nudge. Stop if they come back.",
  },
  {
    from: "agent" as const,
    text: "Created src/journeys/winback.ts — triggers on wentDormant.entered, exits on wentDormant.left, sends reactivation-checkin → ctx.sleep(days(7)) → reactivation-final-nudge. Ran `hogsend journeys --json` to verify — registered. Review the diff.",
  },
];

/** Red atmosphere imagery slot — pure CSS gradient, never copied assets. */
function MediaBackdrop({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative flex min-h-[300px] items-center bg-[#0a0606] p-5",
        className,
      )}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(85% 70% at 50% 115%, rgba(246,72,56,0.35), rgba(246,72,56,0.08) 55%, transparent 80%)",
          filter: "blur(18px)",
        }}
      />
      <div className="relative min-w-0 flex-1">{children}</div>
    </div>
  );
}

function CardLink({
  href,
  children,
  external = false,
}: {
  href: string;
  children: React.ReactNode;
  external?: boolean;
}) {
  const className =
    "group inline-flex items-center gap-1.5 text-sm text-white/70 transition-colors hover:text-white";
  const inner = (
    <>
      <span>{children}</span>
      <ArrowRight
        aria-hidden="true"
        className="size-3.5 transition-transform duration-200 group-hover:translate-x-0.5"
        strokeWidth={1.5}
      />
    </>
  );

  if (external || !href.startsWith("/") || href === "/llms.txt") {
    return (
      <a href={href} className={className}>
        {inner}
      </a>
    );
  }
  return (
    <Link href={href} className={className}>
      {inner}
    </Link>
  );
}

export function FeatureCards({ className }: { className?: string }) {
  return (
    <Section id="agent-native" className={className}>
      <Reveal>
        <SectionHeading
          eyebrow="Agent-native"
          title="Agent-writable, not agent-clickable"
          subtitle="Everyone bolted an MCP server onto their UI this year. Hogsend skipped the step: the entire surface is already the thing agents are best at — typed code in a repo."
        />
      </Reveal>

      <div className="mt-12 grid grid-cols-1 gap-6 md:mt-16 lg:grid-cols-3">
        <Reveal delay={0}>
          <Card className="flex h-full flex-col gap-5 p-0">
            <MediaBackdrop className="rounded-t-md">
              <CodeMock
                filename="src/journeys/winback.ts"
                lines={JOURNEY_LINES}
              />
            </MediaBackdrop>
            <div className="flex flex-1 flex-col gap-2.5 px-6 pb-6">
              <h3 className="font-medium font-sans text-white text-xl leading-[1.2] tracking-[-0.02em]">
                Journeys as code
              </h3>
              <p className="text-base text-white/60 leading-6">
                Journeys are .ts files. Agents read them, write them, and open
                PRs against them. You review a diff, not a screen recording.
              </p>
              <div className="mt-auto pt-3">
                <CardLink href="/docs/guides/journeys">
                  The journeys guide
                </CardLink>
              </div>
            </div>
          </Card>
        </Reveal>

        <Reveal delay={0.08}>
          <Card className="flex h-full flex-col gap-5 p-0">
            <MediaBackdrop className="rounded-t-md">
              <ChatDemo messages={CHAT_MESSAGES} />
            </MediaBackdrop>
            <div className="flex flex-1 flex-col gap-2.5 px-6 pb-6">
              <h3 className="font-medium font-sans text-white text-xl leading-[1.2] tracking-[-0.02em]">
                A CLI that speaks JSON
              </h3>
              <p className="text-base text-white/60 leading-6">
                Every hogsend command takes --json — doctor, journeys, contacts,
                stats, events, webhooks. hogsend skills installs Claude Code
                skills into your repo, and /llms.txt gives every assistant the
                map.
              </p>
              <div className="mt-auto flex flex-wrap gap-x-5 gap-y-2 pt-3">
                <CardLink href="/docs/cli/skills">Skills</CardLink>
                <CardLink href="/docs/cli">The CLI</CardLink>
                <CardLink href="/llms.txt">llms.txt</CardLink>
              </div>
            </div>
          </Card>
        </Reveal>

        <Reveal delay={0.16}>
          <Card className="flex h-full flex-col gap-5 p-0">
            <MediaBackdrop className="rounded-t-md">
              <div className="overflow-hidden rounded-[10px] border border-white/10">
                <Image
                  src={studioOverview}
                  alt="Hogsend Studio — overview dashboard"
                  placeholder="blur"
                  sizes="(min-width: 1024px) 33vw, 100vw"
                  className="h-auto w-full"
                />
              </div>
            </MediaBackdrop>
            <div className="flex flex-1 flex-col gap-2.5 px-6 pb-6">
              <h3 className="font-medium font-sans text-white text-xl leading-[1.2] tracking-[-0.02em]">
                Studio observes, never authors
              </h3>
              <p className="text-base text-white/60 leading-6">
                Every send, journey run, and contact in one dashboard — preview
                templates with live props, resend a failed message, pause a
                sequence. Your editor stays the author.
              </p>
              <div className="mt-auto pt-3">
                <CardLink href="/docs/operating/studio">Studio docs</CardLink>
              </div>
            </div>
          </Card>
        </Reveal>
      </div>
    </Section>
  );
}
