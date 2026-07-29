import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { AccountSection } from "@/components/cloud/account-section";
import { CliSessionsSection } from "@/components/cloud/cli-sessions-section";
import { CopyValue } from "@/components/cloud/copy-value";
import { DangerZoneSection } from "@/components/cloud/danger-zone-section";
import { MembersSection } from "@/components/cloud/members-section";
import { PlanActions } from "@/components/cloud/plan-actions";
import { ProvidersSection } from "@/components/cloud/providers-section";
import { TagPill } from "@/components/ds/badge";
import { Card } from "@/components/ds/card";
import { Hairline } from "@/components/ds/decor";
import { Section } from "@/components/ds/section";
import { PageHeader } from "@/components/shell/page-header";
import { readCliSessionsView } from "@/src/lib/cli-sessions-ops";
import { hasRole, readMembersView } from "@/src/lib/org-members";
import { PLAN_CATALOG } from "@/src/lib/plan-catalog";
import { readProvidersView } from "@/src/lib/provider-keys-ops";
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

type PageProps = {
  /** `?env=` selects which environment's provider keys are shown. */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SettingsPage({ searchParams }: PageProps) {
  const { record, user } = await requireActiveOrganization();
  const region = CLOUD_REGIONS.find((option) => option.id === record.region);
  const requestHeaders = await headers();
  const rawEnv = (await searchParams).env;
  const membersView = await readMembersView(requestHeaders);
  const cliSessionsView = await readCliSessionsView(requestHeaders);
  const providersView = await readProvidersView(requestHeaders, {
    environmentId: Array.isArray(rawEnv) ? rawEnv[0] : rawEnv,
  });

  const owners = membersView.members.filter((member) =>
    hasRole(member.role, "owner"),
  );
  const isSoleOwner = owners.length === 1 && owners[0]?.userId === user.id;

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
            <span className="flex flex-col items-start gap-3 sm:items-end">
              <span className="inline-flex items-center gap-2">
                <TagPill tone="accent">
                  {PLAN_CATALOG[record.plan].label}
                </TagPill>
                <span className="text-white/50 text-xs">
                  {PLAN_CATALOG[record.plan].price}
                </span>
                {record.trialEndsAt ? (
                  <span className="text-white/50 text-xs">
                    trial ends {record.trialEndsAt.toISOString().slice(0, 10)}
                  </span>
                ) : null}
              </span>
              <PlanActions
                plan={record.plan}
                canManage={membersView.canManage}
                billingCustomerId={record.billingCustomerId}
              />
            </span>
          </Row>
          <Hairline />
          <Row label="Organization id">
            <CopyValue value={record.id} label="organization id" />
          </Row>
        </Card>
      </Section>

      <ProvidersSection view={providersView} basePath="/settings" />
      <MembersSection view={membersView} />
      <CliSessionsSection view={cliSessionsView} />
      <AccountSection email={user.email} />
      <DangerZoneSection
        organizationName={record.name}
        isSoleOwner={isSoleOwner}
      />
    </main>
  );
}
