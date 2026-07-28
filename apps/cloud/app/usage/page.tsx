import { Gauge } from "lucide-react";
import type { Metadata } from "next";
import { Card } from "@/components/ds/card";
import { Stat } from "@/components/ds/decor";
import { EmptyState } from "@/components/ds/empty-state";
import { Section } from "@/components/ds/section";
import { PageHeader } from "@/components/shell/page-header";

export const metadata: Metadata = {
  title: "Usage",
  description: "Metered usage across this account's environments.",
};

/** The three metered counters. Values read zero until metering is wired. */
const COUNTERS = [
  { label: "Events ingested", value: "0" },
  { label: "Emails sent", value: "0" },
  { label: "SMS sent", value: "0" },
] as const;

export default function UsagePage() {
  return (
    <main className="flex flex-1 flex-col">
      <PageHeader
        title="Usage"
        description="Metered totals across every environment on this account, for the current billing period."
      />

      <Section divider={false}>
        <div className="grid gap-4 md:grid-cols-3">
          {COUNTERS.map((counter) => (
            <Card key={counter.label}>
              <Stat value={counter.value} label={counter.label} />
            </Card>
          ))}
        </div>
      </Section>

      <Section>
        <EmptyState
          icon={<Gauge aria-hidden className="size-5" strokeWidth={1.75} />}
          title="No usage recorded"
          description="Metering starts when an environment exists and begins handling traffic. Nothing has been recorded on this account."
        />
      </Section>
    </main>
  );
}
