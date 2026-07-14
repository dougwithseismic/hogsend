import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Users } from "lucide-react";
import { useState } from "react";
import { PropertyTable } from "@/components/property-table";
import { StatCard } from "@/components/stat-card";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  TableSkeleton,
} from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getGroup, qk } from "@/lib/admin-api";
import { formatDateTime, formatNumber } from "@/lib/format";
import { ContactDetailDrawer } from "./contacts/contact-detail-drawer";

/**
 * Observe-only Group detail — the header + stats, the group's property bag, and
 * its recent members / recent tagged events. Read-only: no membership or
 * property mutations. Mirrors journey-detail-view.tsx / campaign-detail-view.tsx.
 */
export function GroupDetailView({
  groupType,
  groupKey,
}: {
  groupType: string;
  groupKey: string;
}) {
  const [selectedContactId, setSelectedContactId] = useState<string | null>(
    null,
  );

  const query = useQuery({
    queryKey: qk.group(groupType, groupKey),
    queryFn: () => getGroup(groupType, groupKey),
  });

  const group = query.data?.group;

  return (
    <div className="space-y-6">
      <Link
        to="/groups"
        className="inline-flex items-center gap-1 text-sm text-white/50 hover:text-white/80"
      >
        <ArrowLeft className="h-4 w-4" />
        Groups
      </Link>

      {query.isPending ? (
        <TableSkeleton />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : !group ? null : (
        <>
          <PageHeader
            title={group.displayName || group.groupKey}
            description={group.groupKey}
          />

          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded border border-hairline-faint bg-white/[0.04] px-1.5 py-0.5 font-mono text-white/70 text-xs">
              {group.groupType}
            </code>
            <span className="text-sm text-white/50">
              key{" "}
              <code className="font-mono text-accent">{group.groupKey}</code>
            </span>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard
              label="Members"
              value={formatNumber(group.memberCount)}
              icon={Users}
            />
            <StatCard
              label="First seen"
              value={formatDateTime(group.firstSeenAt)}
            />
            <StatCard
              label="Last seen"
              value={formatDateTime(group.lastSeenAt)}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Properties</CardTitle>
            </CardHeader>
            <CardContent>
              <PropertyTable
                properties={group.properties}
                emptyLabel="No group properties."
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Members</CardTitle>
              <p className="text-xs text-white/40">
                Most recently joined contacts in this group.
              </p>
            </CardHeader>
            <CardContent>
              {group.recentMembers.length === 0 ? (
                <EmptyState
                  title="No members"
                  description="No contacts are associated with this group yet."
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Contact</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Joined</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {group.recentMembers.map((m) => (
                      <TableRow
                        key={m.contactId}
                        className="cursor-pointer"
                        onClick={() => setSelectedContactId(m.contactId)}
                      >
                        <TableCell>
                          <span className="text-white/90">
                            {m.email || m.externalId || m.contactId}
                          </span>
                          {m.email && m.externalId ? (
                            <span className="block font-mono text-xs text-white/50">
                              {m.externalId}
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-white/60">
                          {m.role ?? "—"}
                        </TableCell>
                        <TableCell className="text-white/60">
                          {formatDateTime(m.joinedAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent events</CardTitle>
              <p className="text-xs text-white/40">
                Events tagged with this group, newest first.
              </p>
            </CardHeader>
            <CardContent>
              {group.recentEvents.length === 0 ? (
                <EmptyState
                  title="No events"
                  description="No events tagged with this group have been ingested yet."
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Event</TableHead>
                      <TableHead>User</TableHead>
                      <TableHead>Occurred</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {group.recentEvents.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="font-mono text-xs text-white/90">
                          {e.event}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-white/60">
                          {e.userId}
                        </TableCell>
                        <TableCell className="text-white/60">
                          {formatDateTime(e.occurredAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <ContactDetailDrawer
        contactId={selectedContactId}
        onClose={() => setSelectedContactId(null)}
      />
    </div>
  );
}
