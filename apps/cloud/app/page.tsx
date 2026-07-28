import { Server } from "lucide-react";
import type { Metadata } from "next";
import { EnvironmentTable } from "@/components/cloud/environment-table";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { EmptyState } from "@/components/ds/empty-state";
import { Section } from "@/components/ds/section";
import { PageHeader } from "@/components/shell/page-header";
import { requireActiveOrganization } from "@/src/lib/session";
import { getStackAlerts } from "@/src/pipeline/health-poll";
import { environmentService } from "@/src/services/environments";

export const metadata: Metadata = {
  title: "Overview",
  description: "Environments and stack status for the active organization.",
};

/**
 * The overview states where every environment currently is: the status chip is
 * the stack's own status, verbatim, and a health alert is a badge beside it
 * rather than a status of its own — the poll observes and never transitions.
 */
export default async function HomePage() {
  const { record } = await requireActiveOrganization();
  const [{ environments }, alerts] = await Promise.all([
    environmentService.list({ organizationId: record.id }),
    getStackAlerts({ organizationId: record.id }),
  ]);
  const alertingStackIds = new Set(alerts.map((alert) => alert.stackId));
  const moving = environments.filter((environment) =>
    environment.stack
      ? ["requested", "provisioning", "publishing", "destroying"].includes(
          environment.stack.status,
        )
      : false,
  ).length;
  const failed = environments.filter(
    (environment) => environment.stack?.status === "error",
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

        {moving > 0 || failed > 0 || alerts.length > 0 ? (
          <Card className="flex flex-col gap-2">
            <h2 className="font-medium text-sm text-white tracking-[-0.02em]">
              Right now
            </h2>
            <ul className="flex flex-col gap-1.5 text-sm text-white/60 leading-6">
              {moving > 0 ? (
                <li>
                  {moving === 1
                    ? "One stack is mid-transition; its status moves on its own."
                    : `${moving} stacks are mid-transition; their statuses move on their own.`}
                </li>
              ) : null}
              {failed > 0 ? (
                <li>
                  {failed === 1
                    ? "One stack stopped on an error. Open it to read the step it stopped at and retry from there."
                    : `${failed} stacks stopped on an error. Open each to read the step it stopped at and retry from there.`}
                </li>
              ) : null}
              {alerts.length > 0 ? (
                <li>
                  {alerts.length === 1
                    ? "One running stack has failed every health sweep in the alert streak. The poll does not change a stack's status."
                    : `${alerts.length} running stacks have failed every health sweep in the alert streak. The poll does not change a stack's status.`}
                </li>
              ) : null}
            </ul>
          </Card>
        ) : null}
      </Section>
    </main>
  );
}
