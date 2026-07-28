import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CopyValue } from "@/components/cloud/copy-value";
import { TagPill } from "@/components/ds/badge";
import { Card } from "@/components/ds/card";
import { Hairline } from "@/components/ds/decor";
import { Section } from "@/components/ds/section";
import { PageHeader } from "@/components/shell/page-header";
import { CLOUD_REGIONS } from "@/src/lib/regions";
import { requireActiveOrganization } from "@/src/lib/session";

export const metadata: Metadata = {
  title: "Settings",
  description: "Organization details for this control-plane account.",
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 px-6 py-5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <span className="font-medium text-sm text-white/80 tracking-[-0.02em]">
        {label}
      </span>
      <span className="text-sm text-white/60">{children}</span>
    </div>
  );
}

export default async function SettingsPage() {
  const { record } = await requireActiveOrganization();
  const region = CLOUD_REGIONS.find((option) => option.id === record.region);

  return (
    <main className="flex flex-1 flex-col">
      <PageHeader
        title="Settings"
        description="What this organization is and where it runs. Region is fixed at creation; the plan changes with billing."
      />

      <Section divider={false}>
        <Card className="p-0">
          <Row label="Organization name">{record.name}</Row>
          <Hairline />
          <Row label="Region">
            {region ? `${region.label} (${record.region})` : record.region}
          </Row>
          <Hairline />
          <Row label="Plan">
            <span className="inline-flex items-center gap-2">
              <TagPill tone="accent">{record.plan}</TagPill>
              {record.trialEndsAt ? (
                <span className="text-white/50 text-xs">
                  trial ends {record.trialEndsAt.toISOString().slice(0, 10)}
                </span>
              ) : null}
            </span>
          </Row>
          <Hairline />
          <Row label="Organization id">
            <CopyValue value={record.id} label="organization id" />
          </Row>
        </Card>
      </Section>
    </main>
  );
}
