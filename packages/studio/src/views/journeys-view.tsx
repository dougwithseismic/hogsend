import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  TableSkeleton,
} from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  type JourneyListItem,
  type JourneyMetric,
  listJourneyMetrics,
  listJourneys,
  qk,
  setJourneyEnabled,
} from "@/lib/admin-api";
import { ApiError } from "@/lib/api";
import { formatDuration, formatNumber, formatPercent } from "@/lib/format";
import { links } from "@/lib/links";
import { JourneyFunnel } from "./journeys/journey-funnel";

type Row = JourneyMetric & { enabled: boolean };

export function JourneysView() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toggleTarget, setToggleTarget] = useState<Row | null>(null);

  const metricsQuery = useQuery({
    queryKey: qk.journeyMetrics,
    queryFn: listJourneyMetrics,
  });
  const journeysQuery = useQuery({
    queryKey: qk.journeys,
    queryFn: listJourneys,
  });

  const toggle = useMutation({
    mutationFn: (vars: { id: string; enabled: boolean }) =>
      setJourneyEnabled(vars.id, vars.enabled),
    onSuccess: (_res, vars) => {
      toast({
        title: vars.enabled ? "Journey enabled" : "Journey disabled",
      });
      setToggleTarget(null);
      void queryClient.invalidateQueries({ queryKey: qk.journeys });
      void queryClient.invalidateQueries({ queryKey: qk.journeyMetrics });
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

  const isPending = metricsQuery.isPending || journeysQuery.isPending;
  const isError = metricsQuery.isError || journeysQuery.isError;

  // Merge engine-config enabled flags onto the metric rows by journeyId.
  const enabledMap = new Map<string, boolean>(
    (journeysQuery.data?.journeys ?? []).map((j: JourneyListItem) => [
      j.id,
      j.enabled,
    ]),
  );
  const rows: Row[] = (metricsQuery.data?.journeys ?? []).map((m) => ({
    ...m,
    enabled: enabledMap.get(m.journeyId) ?? false,
  }));

  const selected = rows.find((r) => r.journeyId === selectedId) ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Journeys"
        description="Lifecycle journeys, completion rates, and per-journey funnels."
      />

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
          description="Journeys are defined in code with defineJourney(). Add one to your app, then fire its trigger event from Debug to see it here."
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
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Journey</TableHead>
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
                  key={row.journeyId}
                  className="cursor-pointer"
                  data-state={
                    row.journeyId === selectedId ? "selected" : undefined
                  }
                  onClick={() =>
                    setSelectedId((cur) =>
                      cur === row.journeyId ? null : row.journeyId,
                    )
                  }
                >
                  <TableCell>
                    <span className="font-medium">{row.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {row.journeyId}
                    </span>
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
                  <TableCell className="text-right text-muted-foreground">
                    {formatDuration(row.avgDurationSecs)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={row.enabled ? "default" : "secondary"}>
                      {row.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        setToggleTarget(row);
                      }}
                    >
                      {row.enabled ? "Disable" : "Enable"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {selected ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {selected.name} — funnel
            </CardTitle>
          </CardHeader>
          <CardContent>
            <JourneyFunnel journeyId={selected.journeyId} />
          </CardContent>
        </Card>
      ) : null}

      <ConfirmDialog
        open={toggleTarget !== null}
        onClose={() => setToggleTarget(null)}
        onConfirm={() =>
          toggleTarget &&
          toggle.mutate({
            id: toggleTarget.journeyId,
            enabled: !toggleTarget.enabled,
          })
        }
        title={
          toggleTarget?.enabled
            ? "Disable this journey?"
            : "Enable this journey?"
        }
        description={
          toggleTarget?.enabled
            ? "New events will stop enrolling users into this journey."
            : "New matching events will start enrolling users into this journey."
        }
        confirmLabel={toggleTarget?.enabled ? "Disable" : "Enable"}
        destructive={toggleTarget?.enabled}
        loading={toggle.isPending}
      />
    </div>
  );
}
