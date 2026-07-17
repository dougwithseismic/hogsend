import { useQuery } from "@tanstack/react-query";
import { CausalBadge, CohortLine, LiftValue } from "@/components/lift";
import { EmptyState, ErrorState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DocLink } from "@/components/ui/doc-link";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getJourneyImpact, type JourneyImpact, qk } from "@/lib/admin-api";
import { ApiError } from "@/lib/api";
import { formatDate, formatNumber, formatPercent } from "@/lib/format";
import { links } from "@/lib/links";

/** Fixed window (spec D6) — no picker on the journey card. */
const WINDOW_DAYS = 90;

/**
 * Overall block — the four-way honest split (spec D6 b/c/f):
 *   zero contacts in BOTH cohorts        → EmptyState
 *   causal (held-out cohort exists)      → badge + LiftValue + cohort lines
 *   holdout configured, no controls yet  → the "no held-out contacts" line
 *     (NEVER the add-a-holdout snippet — they already have one)
 *   no holdout                           → observational line + code hint
 */
function OverallBlock({ data }: { data: JourneyImpact }) {
  const { overall, holdout } = data;
  if (overall.treatment.contacts === 0 && overall.control.contacts === 0) {
    return (
      <EmptyState
        title="No impact data yet"
        description={`No contacts entered or were held out of this journey in the last ${data.days} days.`}
      />
    );
  }
  if (overall.causal) {
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <CausalBadge causal />
          <LiftValue
            verdict={overall.verdict}
            combinedConversions={
              overall.treatment.converters + overall.control.converters
            }
          />
        </div>
        <CohortLine
          label={holdout ? `Entered (${100 - holdout.percent}%)` : "Entered"}
          cohort={overall.treatment}
        />
        <CohortLine
          label={holdout ? `Held out (${holdout.percent}%)` : "Held out"}
          cohort={overall.control}
        />
      </div>
    );
  }
  if (holdout !== null) {
    return (
      <p className="text-sm text-white/60">
        Holdout configured ({holdout.percent}%) — no held-out contacts in this
        window yet; lift appears once enrollments accrue.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <div>
        <CausalBadge causal={false} />
      </div>
      <CohortLine label="Entered" cohort={overall.treatment} />
      <div className="space-y-2 rounded-md border border-dashed border-white/15 p-4">
        <p className="text-sm text-white/70">
          No holdout on this journey — the numbers above are observational. Hold
          out a deterministic slice in code to measure causal lift:
        </p>
        <pre className="overflow-x-auto rounded-md bg-black/30 p-3 font-mono text-xs text-white/70">
          {`defineJourney({
  meta: {
    id: "${data.journeyId}",
    // ...
    holdout: { percent: 10 },
  },
  run: async (user, ctx) => {
    // ...
  },
});`}
        </pre>
        <DocLink href={links.impact}>Impact docs</DocLink>
      </div>
    </div>
  );
}

function VersionsBlock({ data }: { data: JourneyImpact }) {
  if (data.versions.length === 0) return null;
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-medium uppercase tracking-wide text-white/40">
        Versions
      </h4>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Version</TableHead>
            <TableHead className="text-right">Enrolled</TableHead>
            <TableHead>Window</TableHead>
            <TableHead className="text-right">Entered rate</TableHead>
            <TableHead className="text-right">Held-out rate</TableHead>
            <TableHead>Lift</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.versions.map((v) => (
            <TableRow key={v.hash ?? "__unversioned__"}>
              <TableCell>
                <span className="font-mono text-xs text-white/90">
                  {v.label ?? v.hash?.slice(0, 12) ?? "pre-versioning"}
                </span>{" "}
                {v.hash !== null && v.hash === data.currentVersionHash ? (
                  <Badge
                    variant="outline"
                    className="border-white/30 bg-white/[0.08] text-white"
                  >
                    current
                  </Badge>
                ) : null}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatNumber(v.enrollments)}
              </TableCell>
              <TableCell className="text-white/60">
                {v.firstEnrolledAt
                  ? `${formatDate(v.firstEnrolledAt)} – ${formatDate(
                      v.lastEnrolledAt,
                    )}`
                  : "—"}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatPercent(v.rate)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {/* A version with zero held-out contacts renders "—" here
                    and in Lift — never an observational number wearing the
                    lift column. */}
                {v.liftVsControl
                  ? formatPercent(v.liftVsControl.control.rate)
                  : "—"}
              </TableCell>
              <TableCell>
                <LiftValue
                  verdict={v.liftVsControl}
                  combinedConversions={
                    v.converters + (v.liftVsControl?.control.converters ?? 0)
                  }
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function VariantsBlock({ data }: { data: JourneyImpact }) {
  if (data.variants.length === 0) return null;
  return (
    <div className="space-y-4">
      {data.variants.map((variant) => (
        <div key={variant.key} className="space-y-2">
          <h4 className="text-xs font-medium uppercase tracking-wide text-white/40">
            Experiment:{" "}
            <code className="font-mono text-accent">{variant.key}</code>
          </h4>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Arm</TableHead>
                <TableHead className="text-right">Contacts</TableHead>
                <TableHead className="text-right">Converters</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead className="text-right">Opens</TableHead>
                <TableHead className="text-right">Clicks</TableHead>
                <TableHead>Lift vs held-out</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {variant.arms.map((arm) => (
                <TableRow key={arm.arm}>
                  <TableCell className="font-mono text-xs text-white/90">
                    {arm.arm}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(arm.enrollments)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(arm.converters)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatPercent(arm.rate)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(arm.engagement.opened)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(arm.engagement.clicked)}
                  </TableCell>
                  <TableCell>
                    <LiftValue
                      verdict={arm.liftVsControl}
                      combinedConversions={
                        arm.converters + data.overall.control.converters
                      }
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ))}
      {data.holdout === null ? (
        <p className="text-xs text-white/40">
          Arms are compared observationally — add a holdout for causal per-arm
          lift.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The journey Impact card (spec D6). Error handling is a DELIBERATE
 * divergence from JourneyRevenueCard (which hides on ANY error): hide ONLY
 * on ApiError 404 — an older engine without the /impact route — and render
 * ErrorState for everything else (never bare `error`: JSX shorthand passes
 * `true` and loses the ApiError message).
 */
export function JourneyImpactCard({ journeyId }: { journeyId: string }) {
  const query = useQuery({
    queryKey: qk.journeyImpact(journeyId, WINDOW_DAYS),
    queryFn: () => getJourneyImpact(journeyId, WINDOW_DAYS),
  });

  if (
    query.isError &&
    query.error instanceof ApiError &&
    query.error.status === 404
  ) {
    return null;
  }

  const goal = query.data?.goal;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Impact</CardTitle>
        {goal ? (
          <p className="text-xs text-white/40">
            {goal.source === "none" ? (
              <>Goal: any conversion · declare meta.goal to pin this readout</>
            ) : (
              <>
                Goal:{" "}
                <code className="font-mono text-white/60">
                  {goal.definitionId}
                </code>
                {goal.source === "goal" ? " (declared in meta.goal)" : null}
              </>
            )}{" "}
            · last {WINDOW_DAYS} days
          </p>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-5">
        {query.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : (
          <>
            <OverallBlock data={query.data} />
            <VersionsBlock data={query.data} />
            <VariantsBlock data={query.data} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
