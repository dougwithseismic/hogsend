import Image from "next/image";
import { Sunburst } from "@/components/ds/doodle";
import { CodeMock, MockupFrame } from "@/components/ds/mockup";
import { ProcessSteps } from "@/components/ds/process";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import lifecycleImg from "@/public/images/hogsend-lifecycle.png";

const SCAFFOLD_LINES = [
  { text: "# Scaffold a thin app that pins the engine", tone: "comment" },
  { text: "$ pnpm dlx create-hogsend@latest my-app", tone: "accent" },
  { text: "", tone: "plain" },
  { text: "$ cd my-app", tone: "plain" },
  { text: "$ pnpm bootstrap   # Docker, .env, token, migrate", tone: "plain" },
  { text: "$ pnpm dev", tone: "plain" },
  { text: "", tone: "plain" },
  { text: "→ API on :3002", tone: "comment" },
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
      "pnpm dlx create-hogsend@latest emits a thin app that pins @hogsend/engine and holds your content.",
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
    <Section tone="cream" id="how-it-works">
      <Reveal>
        <div className="relative max-w-3xl">
          {/* Amber doodle punctuation over the serif heading (decorative;
              Sunburst is already aria-hidden internally). */}
          <Sunburst className="-top-3 -right-2 absolute size-7 md:-top-4 md:size-8" />
          <SectionHeading
            tone="cream"
            eyebrow="HOW IT WORKS"
            title="Three steps, then it just runs"
            subtitle="Activity comes in from PostHog, the right emails go out through Resend, and what people do with them flows right back. Scaffold, define your journeys in TypeScript, and ship — nothing new to buy or keep in sync."
          />
        </div>
      </Reveal>

      <Reveal delay={0.1} className="mt-12 md:mt-16">
        <ProcessSteps tone="light" steps={STEPS} />
      </Reveal>
    </Section>
  );
}
