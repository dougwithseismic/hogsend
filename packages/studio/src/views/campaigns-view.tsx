import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Megaphone } from "lucide-react";
import { useState } from "react";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  TableSkeleton,
} from "@/components/states";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
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
  type Campaign,
  type CampaignListFilters,
  type CampaignStatus,
  cancelCampaign,
  listCampaigns,
  qk,
} from "@/lib/admin-api";
import { ApiError } from "@/lib/api";
import { formatDateTime, formatNumber } from "@/lib/format";

const PAGE_SIZE = 25;

/**
 * Status filter presets. Each maps to the CSV `status` set sent to the API —
 * the pre-send states are grouped under "Scheduled" and the failure terminals
 * under "Failed" so the filter reads the way an operator thinks about a blast.
 */
const STATUS_FILTERS: {
  value: string;
  label: string;
  statuses?: CampaignStatus[];
}[] = [
  { value: "", label: "All" },
  { value: "scheduled", label: "Scheduled", statuses: ["scheduled", "queued"] },
  { value: "sending", label: "Sending", statuses: ["sending"] },
  { value: "sent", label: "Sent", statuses: ["sent"] },
  { value: "canceled", label: "Canceled", statuses: ["canceled"] },
  { value: "failed", label: "Failed", statuses: ["failed", "expired"] },
];

/** In-flight (non-terminal) statuses a cancel is allowed against. */
const CANCELABLE: ReadonlySet<CampaignStatus> = new Set<CampaignStatus>([
  "scheduled",
  "queued",
  "sending",
]);

/** sent/total plus a skipped·failed sub-line, mirroring the dense-cell idiom. */
function CampaignProgress({ campaign }: { campaign: Campaign }) {
  const { totalRecipients, sentCount, skippedCount, failedCount } = campaign;
  const hasNotes = skippedCount > 0 || failedCount > 0;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-white/80">
        {formatNumber(sentCount)} / {formatNumber(totalRecipients)} sent
      </span>
      {hasNotes ? (
        <span className="text-white/40 text-xs">
          {[
            skippedCount > 0 ? `${formatNumber(skippedCount)} skipped` : null,
            failedCount > 0 ? `${formatNumber(failedCount)} failed` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      ) : null}
    </div>
  );
}

/** Confirm-copy that matches the cancel semantics for the target's state. */
function cancelDescription(c: Campaign): string {
  if (c.status === "sending") {
    return `"${c.name}" will stop at the next chunk of 100 recipients. Emails already dispatched cannot be recalled.`;
  }
  return `"${c.name}" is ${c.status} and will not be sent.`;
}

export function CampaignsView() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [statusFilter, setStatusFilter] = useState("");
  const [offset, setOffset] = useState(0);
  const [cancelTarget, setCancelTarget] = useState<Campaign | null>(null);

  const preset = STATUS_FILTERS.find((f) => f.value === statusFilter);

  const apiFilters: CampaignListFilters = {
    status: preset?.statuses,
    limit: PAGE_SIZE,
    offset,
  };

  const query = useQuery({
    queryKey: qk.campaigns(apiFilters),
    queryFn: () => listCampaigns(apiFilters),
    placeholderData: keepPreviousData,
  });

  const cancel = useMutation({
    mutationFn: (id: string) => cancelCampaign(id),
    onSuccess: (updated) => {
      toast({ title: "Campaign canceled" });
      setCancelTarget(null);
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      void queryClient.invalidateQueries({ queryKey: qk.campaign(updated.id) });
    },
    onError: (error) => {
      toast({
        variant: "error",
        title: "Could not cancel campaign",
        description:
          error instanceof ApiError ? error.message : "Unexpected error.",
      });
      setCancelTarget(null);
    },
  });

  const rows = query.data?.campaigns ?? [];
  const hasMore = query.data?.hasMore ?? false;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Campaigns"
        description="One-off broadcasts to a list or bucket. Authored in code or via the API — Studio shows their progress and can cancel one still in flight."
      />

      <div className="flex max-w-xs flex-col gap-1.5">
        <Label htmlFor="campaign-status-filter">Status</Label>
        <Select
          id="campaign-status-filter"
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setOffset(0);
          }}
        >
          {STATUS_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </Select>
      </div>

      {query.isPending ? (
        <TableSkeleton />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title={statusFilter ? "No campaigns match" : "No campaigns yet"}
          description={
            statusFilter
              ? "Try a different status filter."
              : "Queue a broadcast with client.campaigns.send() or the /v1/campaigns API — it will appear here."
          }
        />
      ) : (
        <div className="rounded-lg border bg-white/[0.015]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Audience</TableHead>
                <TableHead>Template</TableHead>
                <TableHead>Scheduled for</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium text-white">
                    {row.name}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={row.status} />
                  </TableCell>
                  <TableCell>
                    <code className="rounded border border-hairline-faint bg-white/[0.04] px-1.5 py-0.5 font-mono text-white/70 text-xs">
                      {row.audienceKind}:{row.audienceId}
                    </code>
                  </TableCell>
                  <TableCell className="text-white/60">
                    {row.templateKey}
                  </TableCell>
                  <TableCell className="text-white/60">
                    {row.status === "scheduled"
                      ? formatDateTime(row.scheduledAt)
                      : "—"}
                  </TableCell>
                  <TableCell>
                    <CampaignProgress campaign={row} />
                  </TableCell>
                  <TableCell className="text-white/60">
                    {formatDateTime(row.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    {CANCELABLE.has(row.status) ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setCancelTarget(row)}
                      >
                        Cancel
                      </Button>
                    ) : (
                      <span className="text-white/30">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {rows.length > 0 && (offset > 0 || hasMore) ? (
        <div className="flex items-center justify-between text-sm text-white/60">
          <span>
            {offset + 1}–{offset + rows.length}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0}
              onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!hasMore}
              onClick={() => setOffset((o) => o + PAGE_SIZE)}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={cancelTarget !== null}
        onClose={() => setCancelTarget(null)}
        onConfirm={() => cancelTarget && cancel.mutate(cancelTarget.id)}
        title="Cancel this campaign?"
        description={cancelTarget ? cancelDescription(cancelTarget) : undefined}
        confirmLabel="Cancel campaign"
        cancelLabel="Keep campaign"
        destructive
        loading={cancel.isPending}
      />
    </div>
  );
}
