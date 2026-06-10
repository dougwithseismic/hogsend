import Image from "next/image";
import { CodeMock, MockupFrame } from "@/components/ds/mockup";
import { ProcessSteps } from "@/components/ds/process";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import lifecycleImg from "@/public/images/hogsend-lifecycle.png";

const SCAFFOLD_LINES = [
  { text: "# Scaffold a thin app that pins the engine", tone: "comment" },
  {
    text: "$ pnpm create hogsend@latest my-app --domain mysite.com",
    tone: "accent",
  },
  { text: "", tone: "plain" },
  { text: "$ cd my-app", tone: "plain" },
  {
    text: "$ hogsend dev   # infra, .env, migrate, API + worker",
    tone: "plain",
  },
  { text: "", tone: "plain" },
  { text: "→ API on :3002 · Studio at /studio", tone: "comment" },
] as const;

const JOURNEY_LINES = [
  { text: "export const welcome = defineJourney({", tone: "keyword" },
  { text: "  meta: {", tone: "plain" },
  { text: '    id: "activation-welcome",', tone: "string" },
  { text: '    trigger: { event: "user_signed_up" },', tone: "string" },
  { text: '    entryLimit: "once",', tone: "string" },
  { text: "  },", tone: "plain" },
  { text: "  run: async (user, ctx) => {", tone: "keyword" },
  {
    text: '    await sendEmail({ to: user.email, template: "welcome" });',
    tone: "plain",
  },
  { text: "    await ctx.sleep({ duration: days(2) });", tone: "plain" },
  {
    text: "    const { found } = await ctx.history.hasEvent({",
    tone: "plain",
  },
  { text: '      userId: user.id, event: "feature_used",', tone: "string" },
  { text: "    });", tone: "plain" },
  {
    text: '    if (!found) await sendEmail({ template: "nudge" });',
    tone: "plain",
  },
  { text: "  },", tone: "plain" },
  { text: "});", tone: "keyword" },
] as const;

const STEPS = [
  {
    n: "01",
    title: "Scaffold your app",
    description:
      "pnpm create hogsend@latest emits a thin app that pins @hogsend/engine and holds your content. Pass --domain to wire your sending domain from the start — every email redirects to your own inbox until the domain verifies, so nothing reaches a customer before you're ready.",
    media: <CodeMock filename="terminal" lines={[...SCAFFOLD_LINES]} />,
  },
  {
    n: "02",
    title: "Define journeys & buckets",
    description:
      "TypeScript functions that trigger on events, send emails, wait, branch, and adapt.",
    media: (
      <CodeMock filename="journeys/welcome.ts" lines={[...JOURNEY_LINES]} />
    ),
  },
  {
    n: "03",
    title: "Deploy & watch it run",
    description:
      "Host with Docker or one-click Railway. Watch every send in Studio.",
    media: (
      <MockupFrame barcode>
        <Image
          src={lifecycleImg}
          alt="The Hogsend lifecycle loop: PostHog activity flows in, journeys send through Resend, engagement flows back."
          placeholder="blur"
          sizes="(min-width: 1024px) 50vw, 100vw"
          className="h-auto w-full rounded-[6px]"
        />
      </MockupFrame>
    ),
  },
];

export function HowItWorks() {
  return (
    <Section tone="light" id="how-it-works">
      <Reveal>
        <SectionHeading
          tone="light"
          eyebrow="HOW IT WORKS"
          title="One loop, not another platform"
          subtitle="Activity comes in from PostHog or any webhook, the right emails go out through Resend, and what people do with them fans back out to your tools — PostHog, Segment, Slack, or anywhere. Nothing new to buy or keep in sync."
        />
      </Reveal>

      <Reveal delay={0.1} className="mt-12 md:mt-16">
        <ProcessSteps tone="light" steps={STEPS} />
      </Reveal>
    </Section>
  );
}
