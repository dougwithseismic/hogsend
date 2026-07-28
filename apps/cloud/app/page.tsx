import { Server } from "lucide-react";
import type { Metadata } from "next";
import { EnvironmentTable } from "@/components/cloud/environment-table";
import { ProvisioningNote } from "@/components/cloud/provisioning-note";
import { Button } from "@/components/ds/button";
import { EmptyState } from "@/components/ds/empty-state";
import { Section } from "@/components/ds/section";
import { PageHeader } from "@/components/shell/page-header";
import { requireActiveOrganization } from "@/src/lib/session";
import { environmentService } from "@/src/services/environments";

export const metadata: Metadata = {
  title: "Overview",
  description: "Environments and stack status for the active organization.",
};

export default async function HomePage() {
  const { record } = await requireActiveOrganization();
  const { environments } = await environmentService.list({
    organizationId: record.id,
  });
  const requested = environments.filter(
    (environment) => environment.stack?.status === "requested",
  ).length;

  return (
    <main className="flex flex-1 flex-col">
      <PageHeader
        title="Overview"
        description={`${record.name} runs in ${record.region} on the ${record.plan} plan.`}
        actions={
          <Button href="/environments" variant="outline">
            View environments
          </Button>
        }
      />

      <Section divider={false} containerClassName="flex flex-col gap-4">
        {environments.length > 0 ? (
          <EnvironmentTable environments={environments} />
        ) : (
          <EmptyState
            icon={<Server aria-hidden className="size-5" strokeWidth={1.75} />}
            title="No environments"
            description="This organization has no environments. Its production environment is created with the organization, so an empty list means one was removed."
          />
        )}

        {requested > 0 ? <ProvisioningNote count={requested} /> : null}
      </Section>
    </main>
  );
}
