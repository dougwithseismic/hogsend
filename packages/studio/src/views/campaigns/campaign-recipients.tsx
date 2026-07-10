import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/states";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type EmailListFilters, listEmails, qk } from "@/lib/admin-api";
import { formatDateTime, formatNumber } from "@/lib/format";
import { SendDetailDrawer } from "@/views/sends/send-detail-drawer";

const PAGE_SIZE = 25;

/**
 * Chip presets over the sends list. Engagement chips are CUMULATIVE (an
 * opened-then-clicked send still counts as opened — matched on the timestamp,
 * not the terminal status), which is how an operator reads a blast.
 */
const RECIPIENT_FILTERS: {
  value: string;
  label: string;
  filter: Pick<EmailListFilters, "status" | "engagement">;
}[] = [
  { value: "all", label: "All", filter: {} },
  { value: "opened", label: "Opened", filter: { engagement: "opened" } },
  { value: "clicked", label: "Clicked", filter: { engagement: "clicked" } },
  { value: "bounced", label: "Bounced", filter: { engagement: "bounced" } },
  { value: "failed", label: "Failed", filter: { status: "failed" } },
];

/**
 * Per-recipient sends of one campaign — the campaign-page sibling of the
 * journey page's Instances browser. Rows open the shared send-detail drawer
 * (delivery timeline + tracked-link clicks).
 */
export function CampaignRecipients({ campaignId }: { campaignId: string }) {
  const [filterValue, setFilterValue] = useState("all");
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const preset = RECIPIENT_FILTERS.find((f) => f.value === filterValue);

  const apiFilters: EmailListFilters = {
    campaignId,
    limit: PAGE_SIZE,
    offset,
    ...(preset?.filter ?? {}),
  };

  const query = useQuery({
    queryKey: qk.emails(apiFilters),
    queryFn: () => listEmails(apiFilters),
    placeholderData: keepPreviousData,
  });

  const emails = query.data?.emails ?? [];
  const total = query.data?.total ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recipients</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-1.5">
          {RECIPIENT_FILTERS.map((f) => (
            <Button
              key={f.value}
              variant={filterValue === f.value ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setFilterValue(f.value);
                setOffset(0);
              }}
            >
              {f.label}
            </Button>
          ))}
        </div>

        {query.isPending ? (
          <TableSkeleton />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : emails.length === 0 ? (
          <EmptyState
            title="No sends"
            description={
              filterValue === "all"
                ? "Per-recipient sends appear here once the blast dispatches."
                : "No recipients match the selected filter."
            }
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Recipient</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Sent</TableHead>
                  <TableHead>Opened</TableHead>
                  <TableHead>Clicked</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {emails.map((email) => (
                  <TableRow
                    key={email.id}
                    className="cursor-pointer"
                    onClick={() => setSelectedId(email.id)}
                  >
                    <TableCell className="font-medium text-white">
                      {email.toEmail}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={email.status} />
                    </TableCell>
                    <TableCell className="text-white/60">
                      {formatDateTime(email.sentAt)}
                    </TableCell>
                    <TableCell className="text-white/60">
                      {email.openedAt ? formatDateTime(email.openedAt) : "—"}
                    </TableCell>
                    <TableCell className="text-white/60">
                      {email.clickedAt ? formatDateTime(email.clickedAt) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="flex items-center justify-between text-sm text-white/50">
              <span>
                {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of{" "}
                {formatNumber(total)}
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
                  disabled={offset + PAGE_SIZE >= total}
                  onClick={() => setOffset((o) => o + PAGE_SIZE)}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>

      <SendDetailDrawer
        emailId={selectedId}
        onClose={() => setSelectedId(null)}
      />
    </Card>
  );
}
