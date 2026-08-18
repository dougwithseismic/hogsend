import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { StatCard } from "@/components/stat-card";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  TableSkeleton,
} from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Combobox } from "@/components/ui/combobox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  getReferralDetail,
  qk,
  type ReferralContact,
  type ReferralValue,
} from "@/lib/admin-api";
import {
  formatAmountWithCode,
  formatDateTime,
  formatNumber,
} from "@/lib/format";
import { ContactDetailDrawer } from "./contacts/contact-detail-drawer";

/**
 * Observe-only referral drill-in: one referrer's descendants and their own
 * touch log, rejected rows included with the reason. Read-only, like the group
 * detail view. The tree is a LEDGER view (every non-rejected edge, no window,
 * no weights), which is why its numbers can differ from the leaderboard's
 * model-weighted value.
 */

function displayName(
  contact: ReferralContact | null,
  contactId: string,
): string {
  return contact?.email || contact?.externalId || contactId;
}

function ValueCell({ value }: { value: ReferralValue[] }) {
  if (value.length === 0) return <span className="text-white/40">—</span>;
  const parts = value.map((v) => formatAmountWithCode(v.value, v.currency));
  return (
    <span className="text-white/80" title={parts.join(" · ")}>
      {parts.join(" · ")}
    </span>
  );
}

/** Status colours: rejected reads muted, qualified reads as the good outcome. */
function StatusCell({
  status,
  reason,
}: {
  status: string;
  reason?: string | null;
}) {
  const tone =
    status === "qualified"
      ? "text-accent"
      : status === "rejected"
        ? "text-white/40"
        : "text-white/70";
  return (
    <span className={tone}>
      {status}
      {reason ? (
        <span className="block text-white/40 text-xs">{reason}</span>
      ) : null}
    </span>
  );
}

export function ReferralDetailView({ contactId }: { contactId: string }) {
  const [depth, setDepth] = useState(3);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(
    null,
  );

  const query = useQuery({
    queryKey: qk.referralDetail(contactId, { depth }),
    queryFn: () => getReferralDetail(contactId, { depth }),
  });

  const data = query.data;
  const nodes = data?.nodes ?? [];
  const touches = data?.touches ?? [];
  const qualified = touches.filter((t) => t.status === "qualified").length;
  const bound = touches.filter(
    (t) => t.status === "bound" || t.status === "qualified",
  ).length;

  return (
    <div className="space-y-6">
      <Link
        to="/referrals"
        className="inline-flex items-center gap-1 text-sm text-white/50 hover:text-white/80"
      >
        <ArrowLeft className="h-4 w-4" />
        Referrals
      </Link>

      {query.isPending ? (
        <TableSkeleton />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : !data ? null : (
        <>
          <PageHeader
            title={displayName(data.contact, data.contactId)}
            description={`Referral program "${data.referral}"`}
          />

          <div className="flex flex-wrap items-center gap-3">
            <Combobox
              ariaLabel="Tree depth"
              className="w-36"
              placeholder="Depth"
              value={String(depth)}
              options={[1, 2, 3, 4, 5].map((d) => ({
                value: String(d),
                label: `${d} level${d === 1 ? "" : "s"}`,
              }))}
              onChange={(next) => setDepth(Number(next) || 1)}
            />
            <span className="font-mono text-white/40 text-xs">
              {data.contactId}
            </span>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Touches" value={formatNumber(touches.length)} />
            <StatCard label="Bound" value={formatNumber(bound)} />
            <StatCard label="Qualified" value={formatNumber(qualified)} />
            <StatCard label="Tree size" value={formatNumber(nodes.length)} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Tree</CardTitle>
              <p className="text-xs text-white/40">
                Descendants to {depth} level{depth === 1 ? "" : "s"}. Every
                non-rejected edge, unweighted and unwindowed.
              </p>
            </CardHeader>
            <CardContent>
              {nodes.length === 0 ? (
                <EmptyState
                  title="No referees"
                  description="Nobody referred by this contact has identified yet."
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Contact</TableHead>
                      <TableHead className="text-right">Level</TableHead>
                      <TableHead>Via</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Conversions</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {nodes.map((n) => (
                      <TableRow
                        key={`${n.contactId}:${n.level}:${n.viaContactId}`}
                        className="cursor-pointer"
                        onClick={() => setSelectedContactId(n.contactId)}
                      >
                        <TableCell className="text-white/90">
                          {displayName(n.contact, n.contactId)}
                        </TableCell>
                        <TableCell className="text-right text-white/70">
                          {n.level}
                        </TableCell>
                        <TableCell className="font-mono text-white/50 text-xs">
                          {n.viaContactId === data.contactId
                            ? "direct"
                            : n.viaContactId}
                        </TableCell>
                        <TableCell>
                          <StatusCell status={n.status} />
                        </TableCell>
                        <TableCell className="text-right text-white/70">
                          {formatNumber(n.conversions)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right">
                          <ValueCell value={n.value} />
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
              <CardTitle>Touch log</CardTitle>
              <p className="text-xs text-white/40">
                Every touch this referrer generated, newest first, rejected ones
                included with their reason.
              </p>
            </CardHeader>
            <CardContent>
              {touches.length === 0 ? (
                <EmptyState
                  title="No touches"
                  description="No click, slug entry or import has recorded a touch for this referrer."
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Referee</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Touched</TableHead>
                      <TableHead>Bound</TableHead>
                      <TableHead>Qualified</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {touches.map((t) => (
                      <TableRow
                        key={t.id}
                        className={t.refereeContactId ? "cursor-pointer" : ""}
                        onClick={() =>
                          t.refereeContactId
                            ? setSelectedContactId(t.refereeContactId)
                            : undefined
                        }
                      >
                        <TableCell>
                          <span className="text-white/90">
                            {t.refereeContactId
                              ? displayName(t.referee, t.refereeContactId)
                              : "unidentified"}
                          </span>
                          <span className="block font-mono text-white/50 text-xs">
                            {t.refereeKey}
                          </span>
                        </TableCell>
                        <TableCell className="font-mono text-white/60 text-xs">
                          {t.source}
                        </TableCell>
                        <TableCell>
                          <StatusCell
                            status={t.status}
                            reason={t.rejectedReason}
                          />
                        </TableCell>
                        <TableCell className="text-white/60">
                          {formatDateTime(t.touchedAt)}
                        </TableCell>
                        <TableCell className="text-white/60">
                          {t.boundAt ? formatDateTime(t.boundAt) : "—"}
                        </TableCell>
                        <TableCell className="text-white/60">
                          {t.qualifiedAt ? formatDateTime(t.qualifiedAt) : "—"}
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
