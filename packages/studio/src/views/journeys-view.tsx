import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  TableSkeleton,
} from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { DocLink } from "@/components/ui/doc-link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import {
  BLUEPRINT_STATUS_LABEL,
  BLUEPRINT_STATUS_VARIANT,
  type BlueprintListItem,
  disableBlueprint,
  enableBlueprint,
  type JourneyListItem,
  type JourneyMetric,
  listBlueprints,
  listJourneyMetrics,
  listJourneys,
  qk,
  setJourneyEnabled,
} from "@/lib/admin-api";
import { ApiError } from "@/lib/api";
import { formatDuration, formatNumber, formatPercent } from "@/lib/format";
import { links } from "@/lib/links";

/**
 * One colocated list for both code journeys (`defineJourney`, git-authored)
 * and blueprints (JSON-authored via MCP, DB-stored) — same table, a `Kind`
 * column tells them apart. `nextEnabled` is what the row's action button
 * would set if clicked — for a blueprint that's also true for a `draft` row
 * (its button reads "Enable", not "Disable").
 */
type Row = {
  kind: "code" | "blueprint";
  id: string;
  name: string;
  enrolled: number;
  active: number;
  completed: number;
  completionRate: number | null;
  avgDurationSecs: number | null;
  statusLabel: string;
  statusVariant: "default" | "secondary" | "outline";
  nextEnabled: boolean;
  /** A promoted blueprint is read-only (the code journey is now the source
   * of truth) — always false for a code row. */
  isPromoted: boolean;
};

function codeRow(m: JourneyMetric, enabled: boolean): Row {
  return {
    kind: "code",
    id: m.journeyId,
    name: m.name,
    enrolled: m.enrolled,
    active: m.active,
    completed: m.completed,
    completionRate: m.completionRate,
    avgDurationSecs: m.avgDurationSecs,
    statusLabel: enabled ? "Enabled" : "Disabled",
    statusVariant: enabled ? "default" : "secondary",
    nextEnabled: !enabled,
    isPromoted: false,
  };
}

// Blueprints don't have a metrics/funnel endpoint yet — `enrolled`/`active`
// are derived from the list route's inline per-status counts, and
// `avgDurationSecs` has no source at all (shown as "—").
function blueprintRow(b: BlueprintListItem): Row {
  const enrolled =
    b.counts.active +
    b.counts.waiting +
    b.counts.completed +
    b.counts.failed +
    b.counts.exited;
  return {
    kind: "blueprint",
    id: b.id,
    name: b.name,
    enrolled,
    active: b.counts.active + b.counts.waiting,
    completed: b.counts.completed,
    completionRate: enrolled > 0 ? b.counts.completed / enrolled : null,
    avgDurationSecs: null,
    statusLabel: BLUEPRINT_STATUS_LABEL[b.status],
    statusVariant: BLUEPRINT_STATUS_VARIANT[b.status],
    nextEnabled: b.status !== "enabled",
    isPromoted: !!b.promotedToJourneyId,
  };
}

export function JourneysView() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [toggleTarget, setToggleTarget] = useState<Row | null>(null);

  const metricsQuery = useQuery({
    queryKey: qk.journeyMetrics,
    queryFn: listJourneyMetrics,
  });
  const journeysQuery = useQuery({
    queryKey: qk.journeys,
    queryFn: listJourneys,
  });
  const blueprintsQuery = useQuery({
    queryKey: qk.blueprints,
    queryFn: listBlueprints,
  });

  const toggle = useMutation({
    mutationFn: async (vars: {
      kind: "code" | "blueprint";
      id: string;
      nextEnabled: boolean;
    }) => {
      if (vars.kind === "code") {
        await setJourneyEnabled(vars.id, vars.nextEnabled);
      } else if (vars.nextEnabled) {
        await enableBlueprint(vars.id);
      } else {
        await disableBlueprint(vars.id);
      }
    },
    onSuccess: (_res, vars) => {
      toast({ title: vars.nextEnabled ? "Enabled" : "Disabled" });
      setToggleTarget(null);
      if (vars.kind === "code") {
        void queryClient.invalidateQueries({ queryKey: qk.journeys });
        void queryClient.invalidateQueries({ queryKey: qk.journeyMetrics });
      } else {
        void queryClient.invalidateQueries({ queryKey: qk.blueprints });
        void queryClient.invalidateQueries({
          queryKey: qk.blueprint(vars.id),
        });
      }
    },
    onError: (error) => {
      toast({
        variant: "error",
        title: "Update failed",
        description:
          error instanceof ApiError ? error.message : "Unexpected error.",
      });
      setToggleTarget(null);
    },
  });

  // Blueprints are additive to this page, not core to it — a blueprints-only
  // fetch failure must not hide the (unrelated, already-working) code
  // journeys, so it's excluded from the page-level pending/error gate and
  // surfaced as its own soft banner instead (below).
  const isPending = metricsQuery.isPending || journeysQuery.isPending;
  const isError = metricsQuery.isError || journeysQuery.isError;

  // Merge engine-config enabled flags onto the metric rows by journeyId.
  const enabledMap = new Map<string, boolean>(
    (journeysQuery.data?.journeys ?? []).map((j: JourneyListItem) => [
      j.id,
      j.enabled,
    ]),
  );
  const rows: Row[] = [
    ...(metricsQuery.data?.journeys ?? []).map((m) =>
      codeRow(m, enabledMap.get(m.journeyId) ?? false),
    ),
    ...(blueprintsQuery.data?.blueprints ?? []).map(blueprintRow),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Journeys"
        description="Lifecycle journeys — defined in code or as JSON blueprints — completion rates, and per-journey funnels."
      />

      {!isPending && !isError && blueprintsQuery.isError ? (
        <div className="rounded-md border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-white/70">
          Couldn't load journey blueprints — showing code journeys only.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => void blueprintsQuery.refetch()}
          >
            Retry
          </button>
        </div>
      ) : null}

      {isPending ? (
        <TableSkeleton />
      ) : isError ? (
        <ErrorState
          error={metricsQuery.error ?? journeysQuery.error}
          onRetry={() => {
            void metricsQuery.refetch();
            void journeysQuery.refetch();
          }}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No journeys registered"
          description="Journeys are defined in code with defineJourney(), or as JSON blueprints created via MCP — either way, they'll show up here."
          action={
            <>
              <DocLink href={links.journeys}>How to create a journey</DocLink>
              <DocLink href={links.recipes} variant="ghost">
                Recipes
              </DocLink>
            </>
          }
        />
      ) : (
        <div className="rounded-lg border bg-white/[0.015]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Journey</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead className="text-right">Enrolled</TableHead>
                <TableHead className="text-right">Active</TableHead>
                <TableHead className="text-right">Completed</TableHead>
                <TableHead className="text-right">Completion</TableHead>
                <TableHead className="text-right">Avg duration</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={`${row.kind}:${row.id}`}
                  className="cursor-pointer"
                  onClick={() =>
                    navigate(
                      row.kind === "code"
                        ? {
                            to: "/journeys/$journeyId",
                            params: { journeyId: row.id },
                          }
                        : {
                            to: "/journeys/blueprints/$blueprintId",
                            params: { blueprintId: row.id },
                          },
                    )
                  }
                >
                  <TableCell>
                    <span className="font-medium text-white">{row.name}</span>
                    <span className="block font-mono text-xs text-white/70">
                      {row.id}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {row.kind === "code" ? "Code" : "Blueprint"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {formatNumber(row.enrolled)}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatNumber(row.active)}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatNumber(row.completed)}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatPercent(row.completionRate)}
                  </TableCell>
                  <TableCell className="text-right text-white/60">
                    {formatDuration(row.avgDurationSecs)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={row.statusVariant}>{row.statusLabel}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {row.isPromoted ? (
                      <span className="text-xs text-white/40">
                        Promoted — read-only
                      </span>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          setToggleTarget(row);
                        }}
                      >
                        {row.nextEnabled ? "Enable" : "Disable"}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <ConfirmDialog
        open={toggleTarget !== null}
        onClose={() => setToggleTarget(null)}
        onConfirm={() =>
          toggleTarget &&
          toggle.mutate({
            kind: toggleTarget.kind,
            id: toggleTarget.id,
            nextEnabled: toggleTarget.nextEnabled,
          })
        }
        title={
          toggleTarget
            ? `${toggleTarget.nextEnabled ? "Enable" : "Disable"} this ${toggleTarget.kind === "blueprint" ? "blueprint" : "journey"}?`
            : ""
        }
        description={
          toggleTarget
            ? toggleTarget.nextEnabled
              ? `New matching events will start enrolling users into this ${toggleTarget.kind === "blueprint" ? "blueprint" : "journey"}.`
              : `New events will stop enrolling users into this ${toggleTarget.kind === "blueprint" ? "blueprint" : "journey"}.`
            : ""
        }
        confirmLabel={toggleTarget?.nextEnabled ? "Enable" : "Disable"}
        destructive={!toggleTarget?.nextEnabled}
        loading={toggle.isPending}
      />
    </div>
  );
}
