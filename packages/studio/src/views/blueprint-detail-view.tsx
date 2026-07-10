import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { ErrorState, PageHeader, TableSkeleton } from "@/components/states";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
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
  type BlueprintDetail,
  disableBlueprint,
  enableBlueprint,
  getBlueprint,
  qk,
} from "@/lib/admin-api";
import { ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { BlueprintFlow } from "./journeys/journey-flow";

/**
 * The `recentStates` already embedded in `GET /:id` (last 10, no filter, no
 * pagination) — the intentionally-thin stand-in for the full
 * filter/paginate/drill-in states browser code journeys have, which needs a
 * blueprint-aware engine route that doesn't exist yet (see the plan).
 */
function RecentInstancesCard({
  states,
}: {
  states: BlueprintDetail["recentStates"];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent instances</CardTitle>
        {states.length > 0 ? (
          <p className="text-xs text-white/40">
            The most recent {states.length} enrollment
            {states.length === 1 ? "" : "s"}.
          </p>
        ) : null}
      </CardHeader>
      <CardContent>
        {states.length === 0 ? (
          <p className="text-sm text-white/50">
            No enrollments yet — instances appear here once an event matches
            this blueprint's trigger.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Step</TableHead>
                <TableHead className="text-right">Entries</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {states.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="text-white/90">
                    {s.userEmail || s.userId}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={s.status} />
                  </TableCell>
                  <TableCell className="font-mono text-xs text-white/60">
                    {s.currentNodeId || "—"}
                  </TableCell>
                  <TableCell className="text-right text-white/60">
                    {s.entryCount}
                  </TableCell>
                  <TableCell className="text-white/60">
                    {formatDateTime(s.updatedAt)}
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

export function BlueprintDetailView({ blueprintId }: { blueprintId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirmToggle, setConfirmToggle] = useState(false);

  const query = useQuery({
    queryKey: qk.blueprint(blueprintId),
    queryFn: () => getBlueprint(blueprintId),
  });

  const toggle = useMutation({
    mutationFn: (nextEnabled: boolean) =>
      nextEnabled
        ? enableBlueprint(blueprintId)
        : disableBlueprint(blueprintId),
    onSuccess: (_res, nextEnabled) => {
      toast({
        title: nextEnabled ? "Blueprint enabled" : "Blueprint disabled",
      });
      setConfirmToggle(false);
      void queryClient.invalidateQueries({
        queryKey: qk.blueprint(blueprintId),
      });
      void queryClient.invalidateQueries({ queryKey: qk.blueprints });
    },
    onError: (error) => {
      toast({
        variant: "error",
        title: "Update failed",
        description:
          error instanceof ApiError ? error.message : "Unexpected error.",
      });
      setConfirmToggle(false);
    },
  });

  const blueprint = query.data?.blueprint;
  const isPromoted = !!blueprint?.promotedToJourneyId;
  const isEnabled = blueprint?.status === "enabled";

  return (
    <div className="space-y-6">
      <Link
        to="/journeys"
        className="inline-flex items-center gap-1 text-sm text-white/50 hover:text-white/80"
      >
        <ArrowLeft className="h-4 w-4" />
        Journeys
      </Link>

      {query.isPending ? (
        <TableSkeleton />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : !blueprint ? null : (
        <>
          <PageHeader
            title={blueprint.name}
            description={blueprint.id}
            action={
              isPromoted ? undefined : (
                <Button
                  variant={isEnabled ? "outline" : "default"}
                  size="sm"
                  onClick={() => setConfirmToggle(true)}
                >
                  {isEnabled ? "Disable" : "Enable"}
                </Button>
              )
            }
          />

          {isPromoted ? (
            <div className="rounded-md border border-accent/30 bg-accent/5 px-3 py-2 text-sm text-white/70">
              Promoted to code journey{" "}
              <code className="font-mono text-accent">
                {blueprint.promotedToJourneyId}
              </code>
              {blueprint.promotedAt
                ? ` on ${formatDateTime(blueprint.promotedAt)}`
                : ""}{" "}
              — the code journey is now the source of truth; this blueprint is
              read-only.
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={BLUEPRINT_STATUS_VARIANT[blueprint.status]}>
              {BLUEPRINT_STATUS_LABEL[blueprint.status]}
            </Badge>
            <Badge variant="outline">Blueprint</Badge>
            <span className="text-sm text-white/50">
              trigger{" "}
              <code className="font-mono text-accent">
                {blueprint.triggerEvent}
              </code>
            </span>
          </div>

          <BlueprintFlow blueprintId={blueprintId} blueprint={blueprint} />

          <RecentInstancesCard states={blueprint.recentStates} />

          <ConfirmDialog
            open={confirmToggle}
            onClose={() => setConfirmToggle(false)}
            onConfirm={() => toggle.mutate(!isEnabled)}
            title={
              isEnabled ? "Disable this blueprint?" : "Enable this blueprint?"
            }
            description={
              isEnabled
                ? "New events will stop enrolling users into this blueprint."
                : "New matching events will start enrolling users into this blueprint."
            }
            confirmLabel={isEnabled ? "Disable" : "Enable"}
            destructive={isEnabled}
            loading={toggle.isPending}
          />
        </>
      )}
    </div>
  );
}
