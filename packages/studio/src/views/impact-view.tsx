import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CausalBadge, LiftValue } from "@/components/lift";
import { StatCard } from "@/components/stat-card";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  TableSkeleton,
} from "@/components/states";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  getImpactOverview,
  type ImpactGlobalControl,
  type ImpactOverview,
  qk,
} from "@/lib/admin-api";
import { ApiError } from "@/lib/api";
import {
  formatAmountWithCode,
  formatNumber,
  formatPercent,
} from "@/lib/format";

const WINDOW_DAYS = 90;

function JourneysCard({ data }: { data: ImpactOverview }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Journeys</CardTitle>
        <p className="text-xs text-white/40">
          Last {data.days} days · ranked by {data.rankedBy} (server order) ·
          attributed value under the "{data.model}" model.
        </p>
      </CardHeader>
      <CardContent>
        {data.journeys.length === 0 ? (
          <EmptyState
            title="No journey activity"
            description="No journey enrollments or attributed credits in the window."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Journey</TableHead>
                <TableHead>Goal</TableHead>
                <TableHead className="text-right">Enrolled</TableHead>
                <TableHead className="text-right">Converters</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead>Attributed value</TableHead>
                <TableHead>Lift</TableHead>
                <TableHead>Evidence</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.journeys.map((row) => (
                <TableRow key={row.journeyId}>
                  <TableCell>
                    <Link
                      to="/journeys/$journeyId"
                      params={{ journeyId: row.journeyId }}
                      className="font-medium text-white hover:text-accent"
                    >
                      {row.name ?? row.journeyId}
                    </Link>
                    {row.versionLabel ? (
                      <span className="block font-mono text-xs text-white/40">
                        {row.versionLabel}
                      </span>
                    ) : null}
                    {!row.registered ? (
                      <span className="block text-xs text-white/40">
                        not registered on this deploy
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-white/60">
                    {row.goalDefinitionId ?? "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(row.observational.enrollments)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(row.observational.converters)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatPercent(row.observational.rate)}
                  </TableCell>
                  <TableCell>
                    {row.attributed.values.length === 0 ? (
                      <span className="text-white/40">—</span>
                    ) : (
                      row.attributed.values.map((v) => (
                        <span
                          key={v.currency ?? "__none__"}
                          className="block text-xs tabular-nums text-white/70"
                        >
                          {formatAmountWithCode(v.value, v.currency)}
                        </span>
                      ))
                    )}
                  </TableCell>
                  <TableCell>
                    {row.lift ? (
                      <LiftValue
                        verdict={row.lift}
                        combinedConversions={
                          // Observational block is TREATMENT-ONLY counts, so
                          // adding the control converters never double-counts.
                          row.observational.converters +
                          row.lift.control.converters
                        }
                      />
                    ) : (
                      <span
                        className="text-white/40"
                        title={
                          row.holdoutPercent !== null
                            ? "Holdout configured — no held-out contacts in window yet."
                            : "No holdout on this journey — add holdout: { percent } to its meta."
                        }
                      >
                        —
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {/* Derived from lift presence — never a row-level flag. */}
                    <CausalBadge causal={row.lift !== null} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function CampaignsCard({ data }: { data: ImpactOverview }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>Campaigns</CardTitle>
          <CausalBadge causal={false} />
        </div>
        <p className="text-xs text-white/40">
          Send funnel + attributed credit only — campaigns have no holdout, so
          no campaign number here is causal.
        </p>
      </CardHeader>
      <CardContent>
        {data.campaigns.rows.length === 0 ? (
          <EmptyState
            title="No campaign activity"
            description={`No campaign sends or credits in the last ${data.days} days.`}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campaign</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Sends</TableHead>
                <TableHead className="text-right">Delivered</TableHead>
                <TableHead className="text-right">Opened</TableHead>
                <TableHead className="text-right">Clicked</TableHead>
                <TableHead>Attributed value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.campaigns.rows.map((row) => (
                <TableRow key={row.campaignId}>
                  <TableCell>
                    <Link
                      to="/campaigns/$campaignId"
                      params={{ campaignId: row.campaignId }}
                      className="font-medium text-white hover:text-accent"
                    >
                      {row.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={row.status} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(row.sends)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(row.delivered)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(row.opened)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(row.clicked)}
                  </TableCell>
                  <TableCell>
                    {row.attributed.length === 0 ? (
                      <span className="text-white/40">—</span>
                    ) : (
                      row.attributed.map((v) => (
                        <span
                          key={v.currency ?? "__none__"}
                          className="block text-xs tabular-nums text-white/70"
                        >
                          {formatAmountWithCode(v.value, v.currency)}
                        </span>
                      ))
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * All THREE states rendered (spec D6): "off" is a dashed env-snippet hint,
 * "skipped" is visibly distinct from off (assignment active, readout
 * absent), "computed" is the StatCard grid + causal LiftValue row.
 */
function GlobalControlCard({ gc }: { gc: ImpactGlobalControl }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Global control</CardTitle>
        <p className="text-xs text-white/40">
          A program-wide held-out slice across every non-transactional send.
        </p>
      </CardHeader>
      <CardContent>
        {gc.state === "off" ? (
          <div className="space-y-2 rounded-md border border-dashed border-white/15 p-4">
            <p className="text-sm text-white/70">
              Global control is off. Hold out a program-wide slice of contacts
              to measure whole-program lift:
            </p>
            <pre className="rounded-md bg-black/30 p-3 font-mono text-xs text-white/70">
              GLOBAL_CONTROL_PERCENT=5
            </pre>
            <p className="text-xs text-white/40">
              Env config on the engine — there is no Studio toggle.
            </p>
          </div>
        ) : gc.state === "skipped" ? (
          <p className="text-sm text-white/70">
            Global control is ON ({gc.percent}%) and suppressing sends, but the
            readout was skipped: {formatNumber(gc.contactCount)} contacts
            exceeds the in-request scan ceiling.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard
                label="Control slice"
                value={`${gc.percent}%`}
                hint={`${formatNumber(gc.contactsScanned)} contacts scanned`}
              />
              <StatCard
                label="Treatment rate"
                value={formatPercent(gc.treatment.rate)}
                hint={`${formatNumber(gc.treatment.converters)} of ${formatNumber(gc.treatment.contacts)} converted`}
              />
              <StatCard
                label="Control rate"
                value={formatPercent(gc.control.rate)}
                hint={`${formatNumber(gc.control.converters)} of ${formatNumber(gc.control.contacts)} converted`}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <CausalBadge causal />
              <LiftValue
                verdict={gc}
                combinedConversions={
                  gc.treatment.converters + gc.control.converters
                }
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ImpactView() {
  const query = useQuery({
    queryKey: qk.impactOverview(WINDOW_DAYS),
    queryFn: () => getImpactOverview(WINDOW_DAYS),
  });

  const notAvailable =
    query.isError &&
    query.error instanceof ApiError &&
    query.error.status === 404;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Impact"
        description="What shipped and what it moved — causal only where a holdout exists."
      />
      {query.isPending ? (
        <TableSkeleton />
      ) : notAvailable ? (
        <EmptyState
          title="Impact readout unavailable"
          description="This engine predates GET /v1/admin/impact/overview. Upgrade @hogsend/engine to see journey lift, versions, and global control here."
        />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : (
        <>
          <JourneysCard data={query.data} />
          <CampaignsCard data={query.data} />
          <GlobalControlCard gc={query.data.globalControl} />
        </>
      )}
    </div>
  );
}
