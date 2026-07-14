import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Building2 } from "lucide-react";
import { useState } from "react";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  TableSkeleton,
} from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type GroupListFilters, listGroups, qk } from "@/lib/admin-api";
import { formatDateTime, formatNumber } from "@/lib/format";

const PAGE_SIZE = 25;

/**
 * Observe-only Groups view — account/team/company-level records tracked from
 * events + memberships. Read-only over HTTP: groups are authored in the data
 * plane, so there is intentionally NO create/edit-group UI. Each row opens the
 * group detail. Mirrors buckets-view.tsx / campaigns-view.tsx.
 */
export function GroupsView() {
  const navigate = useNavigate();
  const [offset, setOffset] = useState(0);

  const filters: GroupListFilters = { limit: PAGE_SIZE, offset };

  const query = useQuery({
    queryKey: qk.groups(filters),
    queryFn: () => listGroups(filters),
    placeholderData: keepPreviousData,
  });

  const rows = query.data?.groups ?? [];
  const total = query.data?.total ?? 0;
  const hasMore = offset + rows.length < total;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Groups"
        description="Account-, team-, and company-level records tracked from events and memberships — observe only, authoring stays in the data plane."
      />

      {query.isPending ? (
        <TableSkeleton />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No groups yet"
          description="Groups appear here as events and memberships arrive carrying a group association (account, team, company, …)."
        />
      ) : (
        <div className="rounded-lg border bg-white/[0.015]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Group</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Members</TableHead>
                <TableHead>Last seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={row.id}
                  className="cursor-pointer"
                  onClick={() =>
                    navigate({
                      to: "/groups/$groupType/$groupKey",
                      params: {
                        groupType: row.groupType,
                        groupKey: row.groupKey,
                      },
                    })
                  }
                >
                  <TableCell>
                    <span className="font-medium text-white">
                      {row.displayName || row.groupKey}
                    </span>
                    <span className="block font-mono text-xs text-white/70">
                      {row.groupKey}
                    </span>
                  </TableCell>
                  <TableCell>
                    <code className="rounded border border-hairline-faint bg-white/[0.04] px-1.5 py-0.5 font-mono text-white/70 text-xs">
                      {row.groupType}
                    </code>
                  </TableCell>
                  <TableCell className="text-right">
                    {formatNumber(row.memberCount)}
                  </TableCell>
                  <TableCell className="text-white/60">
                    {formatDateTime(row.lastSeenAt)}
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
            {offset + 1}–{offset + rows.length} of {formatNumber(total)}
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
    </div>
  );
}
