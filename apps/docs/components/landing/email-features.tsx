import { BellOff, FileCode2, MousePointerClick, Repeat2 } from "lucide-react";
import { FeatureCard } from "@/components/ds/card";
import { Sunburst } from "@/components/ds/doodle";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";

type EmailFeature = {
  icon: React.ReactNode;
  title: string;
  description: string;
};

const ICON = 20;

// The email layer Hogsend owns on every send — accurate to docs/guides/email.
const FEATURES: EmailFeature[] = [
  {
    icon: <FileCode2 size={ICON} strokeWidth={1.5} />,
    title: "React Email templates",
    description:
      "Templates are React components — React Email + Tailwind — versioned in your repo. Edit the copy, swap the brand colour, own them from minute one. No proprietary editor.",
  },
  {
    icon: <MousePointerClick size={ICON} strokeWidth={1.5} />,
    title: "Opens & clicks, tracked",
    description:
      "Every send is tracked first-party — an open pixel and rewritten links. Engagement flows back as events you can branch on mid-journey or pipe straight into PostHog.",
  },
  {
    icon: <BellOff size={ICON} strokeWidth={1.5} />,
    title: "Unsubscribes & preferences",
    description:
      "One-click List-Unsubscribe headers, a hosted preference center, and a suppression check before every send. Compliance is handled for you, not bolted on after.",
  },
  {
    icon: <Repeat2 size={ICON} strokeWidth={1.5} />,
    title: "Bring any provider",
    description:
      "Resend by default — or implement one small interface for Postmark, SES, or your own. Rendering, tracking, and preferences come along for free; the provider is just the wire.",
  },
];

/**
 * "Email, handled" — a cream section that showcases the email layer the engine
 * owns on every send: React Email templates, first-party open/click tracking,
 * unsubscribe + preference management, and a provider-agnostic delivery wire.
 * All claims map to docs/guides/email.mdx.
 */
export function EmailFeatures() {
  return (
    <Section tone="cream" id="email">
      <Reveal>
        <SectionHeading
          tone="cream"
          align="center"
          eyebrow="The email layer"
          title={
            <>
              Everything after{" "}
              <span className="relative inline-block">
                <span className="font-mono text-[0.7em]">send()</span>
                <Sunburst className="-right-6 -top-3 absolute size-6" />
              </span>
              , handled
            </>
          }
          subtitle="Reference a template by key and Hogsend does the rest — render it, track it, keep you compliant, and deliver it through whatever email provider you choose."
          className="mx-auto"
        />
      </Reveal>

      <div className="mt-14 grid grid-cols-1 gap-5 sm:grid-cols-2 md:mt-20">
        {FEATURES.map((feature, index) => (
          <Reveal key={feature.title} delay={(index % 2) * 0.08}>
            <FeatureCard
              tone="light"
              icon={feature.icon}
              title={feature.title}
              description={feature.description}
              className="h-full"
            />
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
