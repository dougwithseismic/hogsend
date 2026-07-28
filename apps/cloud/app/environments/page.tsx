import { Server } from "lucide-react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { CreateEnvironmentForm } from "@/components/cloud/create-environment-form";
import { EnvironmentTable } from "@/components/cloud/environment-table";
import { Button } from "@/components/ds/button";
import { EmptyState } from "@/components/ds/empty-state";
import { Section } from "@/components/ds/section";
import { PageHeader } from "@/components/shell/page-header";
import { canOperateEnvironments } from "@/src/lib/environment-ops";
import { readMemberContext } from "@/src/lib/org-members";
import { requireActiveOrganization } from "@/src/lib/session";
import { getStackAlerts } from "@/src/pipeline/health-poll";
import { environmentService } from "@/src/services/environments";
import { PLAN_ENVIRONMENT_LIMITS } from "@/src/services/orgs";

export const metadata: Metadata = {
  title: "Environments",
  description: "Hogsend instances requested by this organization.",
};

export default async function EnvironmentsPage() {
  const { record } = await requireActiveOrganization();
  const requestHeaders = await headers();
  const [{ environments }, context, alerts] = await Promise.all([
    environmentService.list({ organizationId: record.id }),
    readMemberContext(requestHeaders),
    getStackAlerts({ organizationId: record.id }),
  ]);
  const limit = PLAN_ENVIRONMENT_LIMITS[record.plan];
  const canCreate = canOperateEnvironments(context.role);
  const alertingStackIds = new Set(alerts.map((alert) => alert.stackId));

  return (
    <main className="flex flex-1 flex-col">
      <PageHeader
        title="Environments"
        description={`Each environment is one isolated Hogsend instance with its own database, worker and API URL. The ${record.plan} plan allows ${limit}; ${environments.length} in use. Production is created with the organization.`}
        actions={
          canCreate ? (
            <Button href="#new-environment" variant="solid">
              New environment
            </Button>
          ) : null
        }
      />

      <Section divider={false} containerClassName="flex flex-col gap-4">
        {environments.length > 0 ? (
          <EnvironmentTable
            environments={environments}
            alertingStackIds={alertingStackIds}
          />
        ) : (
          <EmptyState
            icon={<Server aria-hidden className="size-5" strokeWidth={1.75} />}
            title="No environments"
            description="This organization has no environments. Its production environment is created with the organization, so an empty list means one was removed."
          />
        )}

        {canCreate ? (
          <div id="new-environment">
            <CreateEnvironmentForm
              plan={record.plan}
              limit={limit}
              used={environments.length}
            />
          </div>
        ) : null}
      </Section>
    </main>
  );
}
