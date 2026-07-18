import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Flag as FlagIcon, Plus } from "lucide-react";
import { useState } from "react";
import { toTargetingGroup } from "@/components/condition-builder";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  TableSkeleton,
} from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
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
  archiveFlag,
  type Flag,
  type FlagTargeting,
  type FlagTargetingCondition,
  type FlagTargetingLeaf,
  type FlagUpdateBody,
  listFlags,
  qk,
  updateFlag,
} from "@/lib/admin-api";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { renderValue } from "./flags/flag-form";

/**
 * Native feature-flags list. Unlike observe-only Groups/Buckets, flags are
 * OPERATOR-editable: the row's `enabled` Switch PATCHes the flag and takes effect
 * live (no redeploy) — that instant switch is the whole reason flags exist.
 * Creating and editing a flag now happen on the dedicated full-page editor
 * (`/flags/new`, `/flags/$flagId`); the list keeps only the inline enabled toggle
 * and archive (a soft-delete that frees the key). A row click opens the editor.
 */
export function FlagsView() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [includeArchived, setIncludeArchived] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<Flag | null>(null);

  const query = useQuery({
    queryKey: qk.flags(includeArchived),
    queryFn: () => listFlags(includeArchived),
  });

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["flags"] });
  }

  function onMutationError(title: string) {
    return (error: unknown) =>
      toast({
        variant: "error",
        title,
        description:
          error instanceof ApiError ? error.message : "Unexpected error.",
      });
  }

  // The id in the mutation variables lets a single per-row Switch show its own
  // pending state.
  const update = useMutation({
    mutationFn: (vars: { id: string; body: FlagUpdateBody }) =>
      updateFlag(vars.id, vars.body),
    onSuccess: () => invalidate(),
    onError: onMutationError("Could not update flag"),
  });

  const archive = useMutation({
    mutationFn: (id: string) => archiveFlag(id),
    onSuccess: () => {
      toast({ title: "Flag archived" });
      setArchiveTarget(null);
      invalidate();
    },
    onError: onMutationError("Could not archive flag"),
  });

  const flags = query.data?.flags ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Flags"
        description="Native, DB-backed feature flags — toggle, roll out, and target live without a redeploy."
        action={
          <Button onClick={() => void navigate({ to: "/flags/new" })}>
            <Plus className="h-4 w-4" />
            New flag
          </Button>
        }
      />

      <div className="flex items-center justify-end">
        <label
          className="flex cursor-pointer items-center gap-2 text-sm text-white/60"
          htmlFor="flags-show-archived"
        >
          Show archived
          <Switch
            aria-label="Show archived flags"
            checked={includeArchived}
            onCheckedChange={setIncludeArchived}
          />
        </label>
      </div>

      {query.isPending ? (
        <TableSkeleton />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : flags.length === 0 ? (
        <EmptyState
          icon={FlagIcon}
          title="No flags yet"
          description="Create a feature flag to gate rollouts, run experiments, or ship dark launches — evaluated live by the SDKs and journeys."
          action={
            <Button onClick={() => void navigate({ to: "/flags/new" })}>
              <Plus className="h-4 w-4" />
              New flag
            </Button>
          }
        />
      ) : (
        <div className="rounded-lg border bg-white/[0.015]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Flag</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Default</TableHead>
                <TableHead className="text-right">Rollout</TableHead>
                <TableHead>Targeting</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {flags.map((flag) => {
                const archived = flag.archivedAt !== null;
                const toggling =
                  update.isPending && update.variables?.id === flag.id;
                return (
                  <TableRow
                    key={flag.id}
                    className={cn(
                      !archived && "cursor-pointer",
                      archived && "opacity-50",
                    )}
                    onClick={
                      archived
                        ? undefined
                        : () =>
                            navigate({
                              to: "/flags/$flagId",
                              params: { flagId: flag.id },
                            })
                    }
                  >
                    <TableCell>
                      <span className="font-medium text-white">
                        {flag.name}
                      </span>
                      <span className="block font-mono text-white/70 text-xs">
                        {flag.key}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{flag.type}</Badge>
                    </TableCell>
                    <TableCell className="max-w-[16rem] truncate font-mono text-white/70 text-xs">
                      {renderValue(flag.defaultValue)}
                    </TableCell>
                    <TableCell className="text-right text-white/80">
                      {flag.rollout}%
                    </TableCell>
                    <TableCell className="max-w-[18rem] text-white/60 text-xs">
                      {targetingSummary(flag.targeting)}
                    </TableCell>
                    <TableCell>
                      {archived ? (
                        <Badge variant="destructive">Archived</Badge>
                      ) : (
                        // Stop the toggle click bubbling to the row navigation.
                        // biome-ignore lint/a11y/noStaticElementInteractions: click-guard wrapper, not a control
                        // biome-ignore lint/a11y/useKeyWithClickEvents: the Switch inside handles keyboard
                        <span
                          className="inline-flex"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Switch
                            aria-label={`Toggle ${flag.name}`}
                            checked={flag.enabled}
                            disabled={toggling}
                            onCheckedChange={(next) =>
                              update.mutate({
                                id: flag.id,
                                body: { enabled: next },
                              })
                            }
                          />
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {!archived ? (
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate({
                                to: "/flags/$flagId",
                                params: { flagId: flag.id },
                              });
                            }}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              setArchiveTarget(flag);
                            }}
                          >
                            Archive
                          </Button>
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <ConfirmDialog
        open={archiveTarget !== null}
        onClose={() => setArchiveTarget(null)}
        onConfirm={() => archiveTarget && archive.mutate(archiveTarget.id)}
        title="Archive this flag?"
        description={
          archiveTarget
            ? `"${archiveTarget.name}" will stop being served and its key (${archiveTarget.key}) frees for reuse. This is a soft-delete.`
            : undefined
        }
        confirmLabel="Archive"
        destructive
        loading={archive.isPending}
      />
    </div>
  );
}

// --- Targeting summary (list cell) -----------------------------------------

/** Render one leaf as a short, human phrase (ids used bare — no catalog here). */
function leafSummary(c: FlagTargetingLeaf): string {
  switch (c.type) {
    case "property":
      return [
        c.property,
        c.operator,
        c.value === undefined ? "" : String(c.value),
      ]
        .filter(Boolean)
        .join(" ");
    case "bucket":
      return `${c.negate ? "not in" : "in"} bucket ${c.bucketId}`;
    case "journey":
      return `${c.negate ? "not " : ""}${
        c.state === "completed" ? "completed" : "enrolled in"
      } ${c.journeyId}`;
    case "deal":
      return `${c.negate ? "no " : ""}${
        c.predicate === "stage"
          ? `deal at ${c.stage ?? "stage"}`
          : `${c.predicate} deal`
      }`;
    case "event":
      return `event ${c.eventName} ${
        c.check === "count"
          ? `count ${c.operator ?? ""} ${c.value ?? ""}`
          : c.check
      }`.trim();
    case "email_engagement":
      return `email ${c.templateKey} ${c.check}`;
  }
}

/**
 * One-line targeting summary over the condition tree (or a legacy bare array);
 * empty targeting matches everyone. Nested groups render parenthesized and
 * joined by their own AND/OR conjunction.
 */
function targetingSummary(
  targeting: FlagTargeting | FlagTargetingCondition[],
): string {
  const group = toTargetingGroup(targeting);
  return summarizeGroup(group, true) || "Everyone";
}

function summarizeGroup(node: FlagTargeting, top: boolean): string {
  if (node.type !== "composite") return leafSummary(node);
  const joiner = node.operator === "or" ? " OR " : " AND ";
  const parts = node.conditions
    .map((child) => summarizeGroup(child, false))
    .filter(Boolean);
  if (parts.length === 0) return "";
  const joined = parts.join(joiner);
  return top || parts.length === 1 ? joined : `(${joined})`;
}
