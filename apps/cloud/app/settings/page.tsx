import { Settings } from "lucide-react";
import type { Metadata } from "next";
import { Card } from "@/components/ds/card";
import { Hairline } from "@/components/ds/decor";
import { EmptyState } from "@/components/ds/empty-state";
import { Section, SectionHeading } from "@/components/ds/section";
import { PageHeader } from "@/components/shell/page-header";

export const metadata: Metadata = {
  title: "Settings",
  description: "Account, team and API key settings for this control plane.",
};

const SECTIONS = [
  {
    title: "Account",
    body: "Account name, billing email and the plan this account is on.",
  },
  {
    title: "Team",
    body: "The people who can see and change this account's environments.",
  },
  {
    title: "API keys",
    body: "Keys that authenticate calls to the control plane API.",
  },
] as const;

export default function SettingsPage() {
  return (
    <main className="flex flex-1 flex-col">
      <PageHeader
        title="Settings"
        description="Account, team and API key settings. Nothing here is editable yet."
      />

      <Section divider={false}>
        <EmptyState
          icon={<Settings aria-hidden className="size-5" strokeWidth={1.75} />}
          title="Nothing to configure yet"
          description="Settings become editable once accounts and authentication are wired up. Until then this page shows the sections it will hold."
        />
      </Section>

      <Section>
        <SectionHeading eyebrow="Coming to this page" title="Three sections" />
        <Card className="mt-8 p-0">
          {SECTIONS.map((section, index) => (
            <div key={section.title}>
              {index > 0 ? <Hairline /> : null}
              <div className="flex flex-col gap-1.5 p-6">
                <h3 className="font-medium font-sans text-base text-white tracking-[-0.02em]">
                  {section.title}
                </h3>
                <p className="text-sm text-white/60 leading-6">
                  {section.body}
                </p>
              </div>
            </div>
          ))}
        </Card>
      </Section>
    </main>
  );
}
