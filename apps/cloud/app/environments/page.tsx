import { Server } from "lucide-react";
import type { Metadata } from "next";
import { EmptyState } from "@/components/ds/empty-state";
import { Section } from "@/components/ds/section";
import { PageHeader } from "@/components/shell/page-header";

export const metadata: Metadata = {
  title: "Environments",
  description: "Hogsend instances deployed by this account.",
};

export default function EnvironmentsPage() {
  return (
    <main className="flex flex-1 flex-col">
      <PageHeader
        title="Environments"
        description="Each environment is one isolated Hogsend instance with its own database, worker and API URL."
      />

      <Section divider={false}>
        <EmptyState
          icon={<Server aria-hidden className="size-5" strokeWidth={1.75} />}
          title="No environments yet"
          description="Provisioning is not wired up yet. When it is, creating an environment will deploy an API, a worker, Postgres and Redis to the region you pick."
        />
      </Section>
    </main>
  );
}
