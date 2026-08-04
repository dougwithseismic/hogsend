import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { AdvancedDisclosure } from "@/components/cloud/advanced-disclosure";
import { BuildsSection } from "@/components/cloud/builds-section";
import { EnvironmentOperations } from "@/components/cloud/environment-operations";
import { HealthStrip } from "@/components/cloud/health-strip";
import { NetworkingPanel } from "@/components/cloud/networking-panel";
import { OnboardingChecklist } from "@/components/cloud/onboarding-checklist";
import { ProvisionSteps } from "@/components/cloud/provision-steps";
import { ProvisioningCard } from "@/components/cloud/provisioning-card";
import { StackStatusChip } from "@/components/cloud/stack-status-chip";
import { TenantAccessSection } from "@/components/cloud/tenant-access-section";
import { TimeAgo } from "@/components/cloud/time-ago";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { Hairline } from "@/components/ds/decor";
import { Drawer } from "@/components/ds/drawer";
import { Section } from "@/components/ds/section";
import { PageHeader } from "@/components/shell/page-header";
import { readBuildsView } from "@/src/lib/build-views";
import { readEnvironmentDetail } from "@/src/lib/environment-detail";
import { canOperateEnvironments } from "@/src/lib/environment-ops";
import { readOnboarding } from "@/src/lib/onboarding";
import { requireActiveOrganization } from "@/src/lib/session";
import {
  deriveProvisionProgress,
  readTenantAccess,
  readTenantKeys,
} from "@/src/lib/tenant-access";

export const metadata: Metadata = {
  title: "Environment",
  description: "Status, provisioning progress and operations for one stack.",
};

/**
 * One environment, read as the CUSTOMER's first five minutes: is it up, where
 * does it answer, how do I get into it, and how do I turn it off.
 *
 * Four panels in that order — status, networking, keys and connect, operations
 * — and then one disclosure. Topology, engine version, the tenant database
 * name, the Hatchet namespace and the raw provisioning trail are still here,
 * because an operator debugging a stuck stack needs them, but they answer a
 * question nobody has in their first five minutes and every one of them reads
 * as an internal. So they sit inside `Advanced details`, collapsed, rather than
 * as the second thing a new customer meets.
 *
 * The tenancy guard is `readEnvironmentDetail`'s: it scopes the query to the
 * caller's own organization, so another tenant's id and a made-up one both
 * come back null and both render the 404. Nothing on this page reveals that an
 * environment exists somewhere else.
 */

function Row({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-col gap-1.5 px-6 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <span className="font-medium text-sm text-white/80 tracking-[-0.02em]">
        {label}
      </span>
      <span className="text-sm text-white/60">{children}</span>
    </div>
  );
}

/**
 * What the closed Builds row says, so the common question needs no click.
 *
 * The LATEST build only, never a count: `readBuildsView` caps its history, so a
 * total read off that list would stop rising and quietly assert a wrong number
 * forever. What anybody wants from a closed row is "did my last publish work".
 */
function buildsSummary(view: { builds: { status: string }[] }): string {
  const latest = view.builds[0];
  if (!latest) return "nothing published yet";
  return `latest publish ${latest.status}`;
}

/**
 * What the closed Keys row says.
 *
 * An unreachable instance must NOT read as "0 live keys": that is a factual
 * claim about the tenant, and the truth is that we could not ask. The error
 * sentence itself lives inside the drawer, where there is room for it.
 */
function keysSummary(liveCount: number, error: string | null): string {
  if (error) return "could not reach your instance";
  return `${liveCount} live ${liveCount === 1 ? "key" : "keys"}`;
}

/** What the closed Operations row says: the controls actually available now. */
function operationsSummary(allowed: readonly string[]): string {
  if (allowed.length === 0) return "nothing available right now";
  return allowed.join(", ");
}

/** The API URL the pipeline recorded on the substrate handle, if it got there. */
function readApiUrl(refs: Record<string, unknown> | null): string | null {
  const value = refs?.apiPublicUrl;
  return typeof value === "string" ? value : null;
}

export default async function EnvironmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Runs first so a signed-out visitor is sent to /login rather than shown a
  // 404 for an environment that is none of their business either way.
  await requireActiveOrganization();
  const { id } = await params;

  const requestHeaders = await headers();
  const detail = await readEnvironmentDetail(requestHeaders, {
    environmentId: id,
  });
  if (!detail) notFound();

  // Runs after the 404 gate, so a cross-tenant id never reaches the mint-if-
  // absent inside `readBuildsView`.
  const buildsView = await readBuildsView(requestHeaders, {
    environmentId: id,
  });

  // Both re-run the same tenancy scope `readEnvironmentDetail` just passed, so
  // neither can be the one place a foreign id slips through.
  const access = await readTenantAccess(requestHeaders, { environmentId: id });
  // Same tenancy scope again, after the 404 gate above.
  const onboarding = await readOnboarding(requestHeaders, {
    environmentId: id,
  });
  // Live HTTP against the tenant instance, which can be down: this returns an
  // error STRING rather than throwing, so a key list that timed out does not
  // take the rest of the page's status down with it.
  const keys = access?.ready
    ? await readTenantKeys(requestHeaders, { environmentId: id })
    : { keys: [], error: null };

  const { environment, stack, operations } = detail;
  const liveKeys = keys.keys.filter((key) => !key.revokedAt);
  const now = new Date();
  const refs = (stack?.substrateRefs as Record<string, unknown>) ?? null;
  const apiUrl = readApiUrl(refs);
  const progress = deriveProvisionProgress({
    stack: stack
      ? {
          status: stack.status,
          lastError: stack.lastError,
          retryCount: stack.retryCount,
          updatedAt: stack.updatedAt,
        }
      : null,
    steps: detail.steps,
    now,
  });

  return (
    <main className="flex flex-1 flex-col">
      <PageHeader
        title={environment.name}
        description={`The ${environment.kind} environment of this organization — one isolated Hogsend instance with its own database, worker and API URL.`}
        actions={
          <Button href="/environments" variant="outline">
            All environments
          </Button>
        }
      />

      <Section divider={false} containerClassName="flex flex-col gap-4">
        <Card className="p-0">
          <Row label="Status">
            <StackStatusChip status={stack?.status ?? null} />
          </Row>
          <Hairline />
          <Row label="Kind">{environment.kind}</Row>
          <Hairline />
          <Row label="Region">
            {stack?.region ?? "decided when the stack is created"}
          </Row>
          <Hairline />
          <Row label="Created">
            <TimeAgo at={environment.createdAt} now={now} />
          </Row>
        </Card>

        {/*
          Before the instance is usable, `TenantAccessSection` is the
          provisioning card and nothing else — so it leads, out of any drawer.
          Someone waiting on a stack should not have to open something to find
          out how it is going.
        */}
        {access && !access.ready ? (
          <ProvisioningCard progress={progress} now={now} />
        ) : null}

        {/*
          Above the drawers and below the status, because it is the only thing
          on this page with a deadline. It removes itself once every step is
          done — see `OnboardingChecklist`.
        */}
        {onboarding ? <OnboardingChecklist view={onboarding} /> : null}

        <HealthStrip
          health={detail.health}
          alert={detail.alert}
          status={stack?.status ?? null}
          now={now}
        />

        {/*
          Everything below opens in a drawer.
          The page is a short list of what this environment HAS; a drawer is
          where you go to work on one of them. Each row carries the answer most
          visits are after, so the common question — "what is my URL" — never
          needs a click.
        */}
        <div className="flex flex-col gap-2">
          <Drawer
            title="Networking"
            description="The address your instance answers on. Your app sends events here, and the links in your emails are built from it."
            summary={apiUrl ?? "issued while your instance is set up"}
          >
            <NetworkingPanel
              apiUrl={apiUrl}
              studioUrl={access?.studioUrl ?? null}
            />
          </Drawer>

          {access?.ready ? (
            <Drawer
              title="Keys and access"
              description="Open Studio, sign in, and paste a key into your own repository."
              summary={keysSummary(liveKeys.length, keys.error)}
            >
              <TenantAccessSection
                access={access}
                keys={keys.keys}
                keysError={keys.error}
                now={now}
              />
            </Drawer>
          ) : null}

          {buildsView ? (
            <Drawer
              title="Builds"
              description="Every publish to this environment, newest first."
              summary={buildsSummary(buildsView)}
            >
              <BuildsSection
                environmentId={id}
                view={buildsView}
                now={now}
                liveDigest={stack?.imageDigest ?? null}
                // Same gate the server enforces: an operator role, and a stack
                // that is actually running. Drawing a control the action would
                // refuse is a worse answer than not drawing it.
                canRollBack={
                  canOperateEnvironments(operations.role) &&
                  stack?.status === "running"
                }
              />
            </Drawer>
          ) : null}

          <Drawer
            title="Operations"
            description="Suspend, resume, retry or destroy this environment. Each control appears only while the status allows it."
            summary={operationsSummary(operations.allowed)}
          >
            <EnvironmentOperations
              environmentId={environment.id}
              environmentName={environment.name}
              status={stack?.status ?? null}
              allowed={operations.allowed}
              canOperate={canOperateEnvironments(operations.role)}
            />
          </Drawer>
        </div>

        <AdvancedDisclosure summary="Advanced details">
          <Hairline />
          <Row label="Topology">
            {detail.topology} (the {detail.plan} plan)
          </Row>
          <Hairline />
          <Row label="Engine version">
            {stack?.engineVersion ?? "not set until the stack is provisioned"}
          </Row>
          <Hairline />
          <Row label="Tenant database">
            {stack?.dbName ? (
              <span className="font-mono text-white/70 text-xs">
                {stack.dbName}
              </span>
            ) : (
              "not named yet"
            )}
          </Row>
          <Hairline />
          <Row label="Hatchet namespace">
            {stack?.hatchetNamespace ? (
              <span className="font-mono text-white/70 text-xs">
                {stack.hatchetNamespace}
              </span>
            ) : (
              "minted during provisioning"
            )}
          </Row>
          <Hairline />
          <div className="p-4">
            <ProvisionSteps steps={detail.steps} now={now} />
          </div>
        </AdvancedDisclosure>
      </Section>
    </main>
  );
}
