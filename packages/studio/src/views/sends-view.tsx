import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useState } from "react";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  TableSkeleton,
} from "@/components/states";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { type EmailListFilters, listEmails, qk } from "@/lib/admin-api";
import { formatDateTime, truncate } from "@/lib/format";
import { SendDetailDrawer } from "./sends/send-detail-drawer";

const STATUSES = [
  "queued",
  "rendered",
  "sent",
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
  "failed",
];

const ENGAGEMENTS = ["opened", "clicked", "bounced", "complained"];

const PAGE_SIZE = 25;

type Filters = {
  templateKey: string;
  status: string;
  engagement: string;
  journeyId: string;
  userId: string;
  from: string;
  to: string;
};

const EMPTY_FILTERS: Filters = {
  templateKey: "",
  status: "",
  engagement: "",
  journeyId: "",
  userId: "",
  from: "",
  to: "",
};

export function SendsView() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [sort, setSort] = useState("createdAt");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Date inputs are date-only; widen `to` to end-of-day and ISO-encode both.
  const fromIso = filters.from
    ? new Date(`${filters.from}T00:00:00`).toISOString()
    : undefined;
  const toIso = filters.to
    ? new Date(`${filters.to}T23:59:59`).toISOString()
    : undefined;

  const apiFilters: EmailListFilters = {
    limit: PAGE_SIZE,
    offset,
    templateKey: filters.templateKey || undefined,
    status: filters.status || undefined,
    engagement: filters.engagement || undefined,
    journeyId: filters.journeyId || undefined,
    userId: filters.userId || undefined,
    from: fromIso,
    to: toIso,
    sort,
    order,
  };

  const query = useQuery({
    queryKey: qk.emails(apiFilters),
    queryFn: () => listEmails(apiFilters),
    placeholderData: keepPreviousData,
  });

  function patch(next: Partial<Filters>) {
    setFilters((prev) => ({ ...prev, ...next }));
    setOffset(0);
  }

  function toggleSort(column: string) {
    if (sort === column) {
      setOrder((o) => (o === "asc" ? "desc" : "asc"));
    } else {
      setSort(column);
      setOrder("desc");
    }
    setOffset(0);
  }

  const hasFilters = Object.values(filters).some(Boolean);
  const total = query.data?.total ?? 0;
  const emails = query.data?.emails ?? [];

  function SortHead({ column, label }: { column: string; label: string }) {
    const active = sort === column;
    return (
      <TableHead>
        <button
          type="button"
          className="inline-flex items-center gap-1 font-medium hover:text-foreground"
          onClick={() => toggleSort(column)}
        >
          {label}
          {active ? (
            order === "asc" ? (
              <ArrowUp className="h-3 w-3" />
            ) : (
              <ArrowDown className="h-3 w-3" />
            )
          ) : null}
        </button>
      </TableHead>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sends"
        description="Every email sent — filter, sort, and drill into the timeline."
      />

      <div className="grid gap-3 rounded-lg border p-4 md:grid-cols-3 lg:grid-cols-4">
        <div className="space-y-1.5">
          <Label htmlFor="f-template">Template</Label>
          <Input
            id="f-template"
            placeholder="template key"
            value={filters.templateKey}
            onChange={(e) => patch({ templateKey: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="f-status">Status</Label>
          <Select
            id="f-status"
            value={filters.status}
            onChange={(e) => patch({ status: e.target.value })}
          >
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="f-engagement">Engagement</Label>
          <Select
            id="f-engagement"
            value={filters.engagement}
            onChange={(e) => patch({ engagement: e.target.value })}
          >
            <option value="">Any</option>
            {ENGAGEMENTS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="f-journey">Journey ID</Label>
          <Input
            id="f-journey"
            placeholder="journey id"
            value={filters.journeyId}
            onChange={(e) => patch({ journeyId: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="f-user">User ID</Label>
          <Input
            id="f-user"
            placeholder="user id"
            value={filters.userId}
            onChange={(e) => patch({ userId: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="f-from">From</Label>
          <Input
            id="f-from"
            type="date"
            value={filters.from}
            onChange={(e) => patch({ from: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="f-to">To</Label>
          <Input
            id="f-to"
            type="date"
            value={filters.to}
            onChange={(e) => patch({ to: e.target.value })}
          />
        </div>
        {hasFilters ? (
          <div className="flex items-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFilters(EMPTY_FILTERS);
                setOffset(0);
              }}
            >
              Clear filters
            </Button>
          </div>
        ) : null}
      </div>

      {query.isPending ? (
        <TableSkeleton />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : emails.length === 0 ? (
        <EmptyState
          title="No sends found"
          description={
            hasFilters
              ? "Try widening or clearing your filters."
              : "Emails will appear here once your journeys start sending."
          }
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Recipient</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Template</TableHead>
                <TableHead>Status</TableHead>
                <SortHead column="sentAt" label="Sent" />
                <SortHead column="createdAt" label="Created" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {emails.map((email) => (
                <TableRow
                  key={email.id}
                  className="cursor-pointer"
                  onClick={() => setSelectedId(email.id)}
                >
                  <TableCell className="font-medium">{email.toEmail}</TableCell>
                  <TableCell>{truncate(email.subject, 40)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {email.templateKey ?? "—"}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={email.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDateTime(email.sentAt)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDateTime(email.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {total > 0 ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
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
      ) : null}

      <SendDetailDrawer
        emailId={selectedId}
        onClose={() => setSelectedId(null)}
      />
    </div>
  );
}
