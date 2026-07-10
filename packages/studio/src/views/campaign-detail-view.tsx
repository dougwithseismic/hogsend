import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ErrorState, PageHeader, TableSkeleton } from "@/components/states";
import { StatusBadge } from "@/components/status-badge";
import { TemplatePreviewFrame } from "@/components/template-preview";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
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
  cancelCampaign,
  getCampaign,
  getCampaignStats,
  qk,
} from "@/lib/admin-api";
import { ApiError } from "@/lib/api";
import { formatDateTime, formatNumber } from "@/lib/format";
import { CANCELABLE, cancelDescription } from "./campaigns/campaign-cancel";
import { CampaignFunnel } from "./campaigns/campaign-funnel";
import { CampaignLifecycle } from "./campaigns/campaign-lifecycle";
import { CampaignRecipients } from "./campaigns/campaign-recipients";
import { formatCountdown, isMultiStep } from "./campaigns/campaign-steps";

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:gap-4">
      <span className="w-24 shrink-0 text-sm text-white/50">{label}</span>
      <div className="min-w-0 flex-1 text-sm text-white/90">{children}</div>
    </div>
  );
}

function CodeChip({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-xs text-white/80">
      {children}
    </code>
  );
}

function CampaignMetaCard({ campaign }: { campaign: Campaign }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Definition</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <MetaRow label="Audience">
          <CodeChip>
            {campaign.audienceKind}:{campaign.audienceId}
          </CodeChip>
        </MetaRow>
        <MetaRow label="Template">
          <CodeChip>{campaign.templateKey}</CodeChip>
        </MetaRow>
        {isMultiStep(campaign) ? (
          <MetaRow label="Steps">
            {campaign.steps.length} steps ·{" "}
            {campaign.steps.filter((s) => s.kind === "send").length} send waves
          </MetaRow>
        ) : null}
        <MetaRow label="Subject">
          {campaign.subject ?? (
            <span className="text-white/40">template default</span>
          )}
        </MetaRow>
        <MetaRow label="From">
          {campaign.fromEmail ?? (
            <span className="text-white/40">default sender</span>
          )}
        </MetaRow>
        <MetaRow label="Schedule">
          {campaign.scheduledAt ? (
            formatDateTime(campaign.scheduledAt)
          ) : (
            <span className="text-white/40">immediate</span>
          )}
        </MetaRow>
        <MetaRow label="Created">{formatDateTime(campaign.createdAt)}</MetaRow>
      </CardContent>
    </Card>
  );
}

/**
 * Sibling of the journey page's Email card — dispatch + engagement counters
 * per template with a toggleable preview. A single-send campaign is one row
 * (the campaign's template); a multi-step campaign gets one row PER SEND
 * WAVE from the per-step stats (rows keyed by step index, since two waves
 * may legitimately send the same template).
 */
function CampaignEmailCard({ campaign }: { campaign: Campaign }) {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const stats = useQuery({
    queryKey: qk.campaignStats(campaign.id),
    queryFn: () => getCampaignStats(campaign.id),
  });

  const multiStep = isMultiStep(campaign);
  const rows =
    stats.data === undefined
      ? []
      : multiStep && stats.data.steps
        ? stats.data.steps
            .filter((s) => s.kind === "send")
            .map((s) => ({
              stepIndex: s.index,
              templateKey: s.templateKey ?? campaign.templateKey,
              sent: s.sends,
              opened: s.opened,
              clicked: s.clicked,
              lastSentAt: s.lastSentAt,
            }))
        : [
            {
              stepIndex: 0,
              templateKey: campaign.templateKey,
              sent: campaign.sentCount,
              opened: stats.data.opened,
              clicked: stats.data.clicked,
              lastSentAt: stats.data.lastSentAt,
            },
          ];
  const preview = rows.find((r) => r.stepIndex === previewIndex);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {stats.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : stats.isError ? (
          <ErrorState error={stats.error} onRetry={() => stats.refetch()} />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Template</TableHead>
                  <TableHead className="text-right">Sent</TableHead>
                  <TableHead className="text-right">Opened</TableHead>
                  <TableHead className="text-right">Clicked</TableHead>
                  <TableHead>Last sent</TableHead>
                  <TableHead className="text-right">Preview</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.stepIndex}>
                    <TableCell className="font-mono text-xs text-white/90">
                      {multiStep ? (
                        // Step numbering matches the funnel's wave breakdown.
                        <span className="text-white/40">
                          step {row.stepIndex + 1} ·{" "}
                        </span>
                      ) : null}
                      {row.templateKey}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatNumber(row.sent)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatNumber(row.opened)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatNumber(row.clicked)}
                    </TableCell>
                    <TableCell className="text-white/60">
                      {row.lastSentAt ? formatDateTime(row.lastSentAt) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setPreviewIndex((cur) =>
                            cur === row.stepIndex ? null : row.stepIndex,
                          )
                        }
                      >
                        {previewIndex === row.stepIndex ? "Hide" : "Preview"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {preview ? (
              <TemplatePreviewFrame templateKey={preview.templateKey} />
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function CampaignDetailView({ campaignId }: { campaignId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirmCancel, setConfirmCancel] = useState(false);

  const query = useQuery({
    queryKey: qk.campaign(campaignId),
    queryFn: () => getCampaign(campaignId),
    // A live blast moves — keep the lifecycle band + counters fresh while the
    // worker chews through chunks. A `waiting` campaign only moves at
    // `nextStepAt` (possibly days away), so poll it slowly — just enough for
    // the page to flip to `sending` without a manual reload.
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      if (status === "queued" || status === "sending") return 4000;
      if (status === "waiting") return 30000;
      return false;
    },
  });

  const cancel = useMutation({
    mutationFn: () => cancelCampaign(campaignId),
    onSuccess: () => {
      toast({ title: "Campaign canceled" });
      setConfirmCancel(false);
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      void queryClient.invalidateQueries({ queryKey: qk.campaign(campaignId) });
      void queryClient.invalidateQueries({
        queryKey: qk.campaignStats(campaignId),
      });
    },
    onError: (error) => {
      toast({
        variant: "error",
        title: "Could not cancel campaign",
        description:
          error instanceof ApiError ? error.message : "Unexpected error.",
      });
      setConfirmCancel(false);
    },
  });

  const campaign = query.data;

  return (
    <div className="space-y-6">
      <Link
        to="/campaigns"
        className="inline-flex items-center gap-1 text-sm text-white/50 hover:text-white/80"
      >
        <ArrowLeft className="h-4 w-4" />
        Campaigns
      </Link>

      {query.isPending ? (
        <TableSkeleton />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : !campaign ? null : (
        <>
          <PageHeader
            title={campaign.name}
            description={campaign.id}
            action={
              CANCELABLE.has(campaign.status) ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmCancel(true)}
                >
                  Cancel campaign
                </Button>
              ) : undefined
            }
          />

          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={campaign.status} />
            <span className="text-sm text-white/50">
              to{" "}
              <code className="font-mono text-accent">
                {campaign.audienceKind}:{campaign.audienceId}
              </code>
            </span>
            {campaign.status === "waiting" && campaign.nextStepAt ? (
              <span className="text-sm text-white/50">
                · next wave in{" "}
                <span className="text-white/80">
                  {formatCountdown(campaign.nextStepAt)}
                </span>{" "}
                ({formatDateTime(campaign.nextStepAt)})
              </span>
            ) : null}
          </div>

          {/* The lifecycle band — the campaign-shaped sibling of the journey
              page's flow canvas (linear, so a strip rather than a graph). */}
          <CampaignLifecycle campaign={campaign} />

          <div className="grid gap-4 lg:grid-cols-2">
            <CampaignMetaCard campaign={campaign} />
            <Card>
              <CardHeader>
                <CardTitle>Delivery</CardTitle>
              </CardHeader>
              <CardContent>
                <CampaignFunnel campaign={campaign} />
              </CardContent>
            </Card>
          </div>

          <CampaignEmailCard campaign={campaign} />
          <CampaignRecipients campaignId={campaignId} />

          <ConfirmDialog
            open={confirmCancel}
            onClose={() => setConfirmCancel(false)}
            onConfirm={() => cancel.mutate()}
            title="Cancel this campaign?"
            description={cancelDescription(campaign)}
            confirmLabel="Cancel campaign"
            cancelLabel="Keep campaign"
            destructive
            loading={cancel.isPending}
          />
        </>
      )}
    </div>
  );
}
