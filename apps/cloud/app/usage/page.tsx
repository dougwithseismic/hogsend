import { Gauge } from "lucide-react";
import type { Metadata } from "next";
import { EmptyState } from "@/components/ds/empty-state";
import { Section } from "@/components/ds/section";
import { PageHeader } from "@/components/shell/page-header";
import { requireActiveOrganization } from "@/src/lib/session";

export const metadata: Metadata = {
  title: "Usage",
  description: "Metered usage across this organization's environments.",
};

export default async function UsagePage() {
  const { record } = await requireActiveOrganization();

  return (
    <main className="flex flex-1 flex-col">
      <PageHeader
        title="Usage"
        description={`Metered totals for ${record.name}: events ingested, emails sent and SMS sent, per environment and billing period.`}
      />

      <Section divider={false}>
        {/* No counters are rendered on purpose. Zeroes next to "events
            ingested" would read as a measurement; nothing is measuring yet. */}
        <EmptyState
          icon={<Gauge aria-hidden className="size-5" strokeWidth={1.75} />}
          title="Nothing is being metered yet"
          description="Metering writes a counter per environment per period, and needs a running environment to count. It lands with billing, alongside plan limits and invoices."
        />
      </Section>
    </main>
  );
}
