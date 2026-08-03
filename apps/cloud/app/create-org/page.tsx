import type { Metadata } from "next";
import { TagPill } from "@/components/ds/badge";
import { Card } from "@/components/ds/card";
import { Wordmark } from "@/components/ds/wordmark";
import { CreateOrgForm } from "@/components/org/create-org-form";
import { CLOUD_REGIONS, listAcceptingRegions } from "@/src/lib/regions";
import { requireCreateOrgAccess } from "@/src/lib/session";

export const metadata: Metadata = {
  title: "Create an organization",
  description: "Name your organization and pick the region its data lives in.",
};

/** DECISIONS §2 environment allowances, stated as the plan's offer. */
const PLANS = [
  {
    name: "Trial",
    detail: "14 days, one production environment on shared infrastructure.",
    status: "Starts here",
    current: true,
  },
  {
    name: "Self-serve",
    detail: "Two environments on shared infrastructure, billed monthly.",
    status: "Arrives with billing",
    current: false,
  },
  {
    name: "Dedicated",
    detail: "Four environments on infrastructure of its own, in any region.",
    status: "Arrives with billing",
    current: false,
  },
] as const;

export default async function CreateOrgPage() {
  await requireCreateOrgAccess();

  const accepting = await listAcceptingRegions();
  const regions = CLOUD_REGIONS.filter((region) =>
    accepting.includes(region.id),
  );

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="flex w-full max-w-2xl flex-col gap-8">
        <Wordmark />

        <Card className="flex flex-col gap-8 hover:border-white/[0.08]">
          <div className="flex flex-col gap-2">
            <h1 className="font-display text-[24px] text-white leading-[1.2] tracking-[-0.02em]">
              Create an organization
            </h1>
            <p className="text-sm text-white/60 leading-6">
              An organization owns your environments, billing and team. Creating
              one also requests your production environment.
            </p>
          </div>

          <CreateOrgForm
            regions={[...regions]}
            hasDrainedRegions={regions.length < CLOUD_REGIONS.length}
          />
        </Card>

        <div className="flex flex-col gap-3">
          <h2 className="font-medium text-sm text-white/80 tracking-[-0.02em]">
            Plans
          </h2>
          <p className="text-sm text-white/50 leading-6">
            Every organization starts on the trial. Paid plans are not
            selectable until billing can charge for them.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {PLANS.map((plan) => (
              <Card key={plan.name} className="flex flex-col gap-3 p-4">
                <div className="flex flex-col items-start gap-2">
                  <h3 className="font-medium text-sm text-white tracking-[-0.02em]">
                    {plan.name}
                  </h3>
                  <TagPill tone={plan.current ? "accent" : "neutral"}>
                    {plan.status}
                  </TagPill>
                </div>
                <p className="text-white/50 text-xs leading-5">{plan.detail}</p>
              </Card>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
