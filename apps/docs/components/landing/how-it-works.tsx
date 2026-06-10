import { CodeMock } from "@/components/ds/mockup";
import { ProcessSteps } from "@/components/ds/process";
import { Section } from "@/components/ds/section";

const SCAFFOLD_LINES: Parameters<typeof CodeMock>[0]["lines"] = [
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
];

const JOURNEY_LINES: Parameters<typeof CodeMock>[0]["lines"] = [
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
];

const DEPLOY_LINES: Parameters<typeof CodeMock>[0]["lines"] = [
  { text: "# One-click Railway template, or your own host", tone: "comment" },
  { text: "$ git push origin main", tone: "accent" },
  { text: "", tone: "plain" },
  { text: "→ building hogsend-api …", tone: "comment" },
  { text: "→ building hogsend-worker …", tone: "comment" },
  { text: "→ migrations applied · health check /v1/health ✓", tone: "plain" },
  { text: "", tone: "plain" },
  { text: "# Watch every send in Studio", tone: "comment" },
];

const STEPS = [
  {
    n: "01",
    title: "Scaffold your app",
    description:
      "pnpm create hogsend@latest emits a thin app that pins @hogsend/engine and holds your content. Pass --domain to wire your sending domain from the start — sends redirect to your own inbox until the domain verifies.",
    media: <CodeMock filename="terminal" lines={SCAFFOLD_LINES} />,
  },
  {
    n: "02",
    title: "Define journeys & buckets",
    description:
      "TypeScript functions that trigger on events, send emails, wait, branch, and adapt.",
    media: <CodeMock filename="journeys/welcome.ts" lines={JOURNEY_LINES} />,
  },
  {
    n: "03",
    title: "Deploy & watch it run",
    description:
      "Host with Docker or one-click Railway. Watch every send in Studio.",
    media: <CodeMock filename="deploy" lines={DEPLOY_LINES} />,
  },
];

export function HowItWorks() {
  return (
    <Section id="how-it-works" className="overflow-visible">
      {/* No Reveal wrapper and no overflow-hidden here: a transform or a
          non-visible overflow on any ancestor disables the sticky left
          column inside ProcessSteps. */}
      <ProcessSteps
        eyebrow="How it works"
        title="One loop, not another platform"
        subtitle="Activity comes in from PostHog or any webhook, the right emails go out through your provider, and what people do with them fans back out to your tools — PostHog, Segment, Slack, or anywhere. Nothing new to buy or keep in sync."
        steps={STEPS}
      />
    </Section>
  );
}
