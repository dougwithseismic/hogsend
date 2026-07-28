import { Server } from "lucide-react";
import { Button } from "@/components/ds/button";
import { FeatureCard } from "@/components/ds/card";
import { EmptyState } from "@/components/ds/empty-state";
import { Section, SectionHeading } from "@/components/ds/section";
import { PageHeader } from "@/components/shell/page-header";

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <PageHeader
        title="Overview"
        description="This account has no environments. Once one exists, its status, region and usage appear here."
        actions={
          <Button href="/environments" variant="outline">
            View environments
          </Button>
        }
      />

      <Section divider={false}>
        <EmptyState
          icon={<Server aria-hidden className="size-5" strokeWidth={1.75} />}
          title="No environments yet"
          description="An environment is one Hogsend instance — an API, a worker, Postgres and Redis — deployed to a region you pick."
          actions={
            <Button href="/environments" icon>
              Go to environments
            </Button>
          }
        />
      </Section>

      <Section>
        <SectionHeading
          eyebrow="What lives here"
          title="Three surfaces"
          subtitle="Provisioning, billing and account settings are not wired up yet. These pages exist so the shell they sit in is settled first."
        />
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          <FeatureCard
            title="Environments"
            description="One row per deployed Hogsend instance: region, status, and the URL its SDKs point at."
          />
          <FeatureCard
            title="Usage"
            description="Events ingested, emails sent and SMS sent per environment, per billing period."
          />
          <FeatureCard
            title="Settings"
            description="Account details, team members and the API keys used to call the control plane."
          />
        </div>
      </Section>
    </main>
  );
}
