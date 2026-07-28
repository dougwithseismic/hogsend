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
import { PLAN_ENVIRONMENT_LIMITS } from "@/src/services/orgs";

export const metadata: Metadata = {
  title: "Environments",
  description: "Hogsend instances requested by this organization.",
};

export default async function EnvironmentsPage() {
  const { record } = await requireActiveOrganization();
  const { environments } = await environmentService.list({
    organizationId: record.id,
  });
  const requested = environments.filter(
    (environment) => environment.stack?.status === "requested",
  ).length;
  const limit = PLAN_ENVIRONMENT_LIMITS[record.plan];

  return (
    <main className="flex flex-1 flex-col">
      <PageHeader
        title="Environments"
        description={`Each environment is one isolated Hogsend instance with its own database, worker and API URL. The ${record.plan} plan allows ${limit}; ${environments.length} in use.`}
        actions={
          // Deliberately disabled: creating an environment would record a
          // second `requested` stack that nothing can build yet.
          <Button type="button" disabled>
            New environment — arrives with provisioning
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
