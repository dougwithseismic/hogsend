import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Copy, ExternalLink } from "lucide-react";
import { useMemo, useState } from "react";
import { StatCard } from "@/components/stat-card";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  TableSkeleton,
} from "@/components/states";
import { Button } from "@/components/ui/button";
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
import { useToast } from "@/components/ui/toast";
import {
  getReferralDetail,
  qk,
  type ReferralContact,
  type ReferralTouch,
  type ReferralTreeNode,
  type ReferralValue,
} from "@/lib/admin-api";
import {
  formatAmountWithCode,
  formatDateTime,
  formatNumber,
  formatRelative,
} from "@/lib/format";
import { ContactDetailDrawer } from "./contacts/contact-detail-drawer";

/**
 * Observe-only referral drill-in: one referrer's share links, their
 * descendants drawn as the tree they are, and their own touch log with the
 * rejected rows and reasons. Read-only, like the group detail view. The tree
 * is a LEDGER view (every non-rejected edge, no window, no weights), which is
 * why its numbers can differ from the leaderboard's model-weighted value.
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

function valueString(value: ReferralValue[]): string {
  if (value.length === 0) return "—";
  return value
    .map((v) => formatAmountWithCode(v.value, v.currency))
    .join(" · ");
}

/** Sum a list of per-currency values, per currency. Never across currencies. */
function sumValues(lists: ReferralValue[][]): ReferralValue[] {
  const totals = new Map<string, number>();
  for (const list of lists) {
    for (const v of list) {
      totals.set(v.currency, (totals.get(v.currency) ?? 0) + v.value);
    }
  }
  return [...totals.entries()]
    .map(([currency, value]) => ({ currency, value }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

const STATUS_TONE: Record<string, string> = {
  qualified: "bg-accent",
  bound: "bg-white/60",
  touched: "bg-white/25",
  rejected: "bg-white/10",
};

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
    <span className={`inline-flex items-center gap-2 ${tone}`}>
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${
          STATUS_TONE[status] ?? "bg-white/25"
        }`}
      />
      <span>
        {status}
        {reason ? (
          <span className="block text-white/40 text-xs">{reason}</span>
        ) : null}
      </span>
    </span>
  );
}

/**
 * Order the flat node list depth-first so a child renders directly under its
 * parent, and carry the level for indentation. A referee reached by two paths
 * appears once per path (that is what the ledger holds).
 */
function orderTree(
  rootId: string,
  nodes: ReferralTreeNode[],
): ReferralTreeNode[] {
  const byParent = new Map<string, ReferralTreeNode[]>();
  for (const node of nodes) {
    const list = byParent.get(node.viaContactId) ?? [];
    list.push(node);
    byParent.set(node.viaContactId, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.touchedAt.localeCompare(b.touchedAt));
  }
  const out: ReferralTreeNode[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string, level: number) => {
    for (const node of byParent.get(parentId) ?? []) {
      if (node.level !== level) continue;
      const key = `${node.contactId}:${node.level}:${node.viaContactId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(node);
      walk(node.contactId, level + 1);
    }
  };
  walk(rootId, 1);
  // Anything the walk could not reach (a truncated tree) still gets listed.
  for (const node of nodes) {
    const key = `${node.contactId}:${node.level}:${node.viaContactId}`;
    if (!seen.has(key)) out.push(node);
  }
  return out;
}

const STATUS_FILTERS = ["all", "qualified", "bound", "touched", "rejected"];

export function ReferralDetailView({ contactId }: { contactId: string }) {
  const { toast } = useToast();
  const [depth, setDepth] = useState(3);
  const [statusFilter, setStatusFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
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
  const links = data?.links ?? [];

  const ordered = useMemo(
    () => (data ? orderTree(data.contactId, nodes) : []),
    [data, nodes],
  );

  const qualified = touches.filter((t) => t.status === "qualified").length;
  const bound = touches.filter(
    (t) => t.status === "bound" || t.status === "qualified",
  ).length;
  const rejected = touches.filter((t) => t.status === "rejected");
  const rejectedByReason = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of rejected) {
      const reason = t.rejectedReason ?? "unknown";
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [rejected]);
  const treeValue = useMemo(
    () => sumValues(nodes.map((n) => n.value)),
    [nodes],
  );
  const directValue = useMemo(
    () => sumValues(nodes.filter((n) => n.level === 1).map((n) => n.value)),
    [nodes],
  );
  const sources = useMemo(
    () => [...new Set(touches.map((t) => t.source))].sort(),
    [touches],
  );

  const visibleTouches = touches.filter(
    (t: ReferralTouch) =>
      (statusFilter === "all" || t.status === statusFilter) &&
      (sourceFilter === "all" || t.source === sourceFilter),
  );

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast({ title: "Copied to clipboard" });
    } catch {
      toast({ variant: "error", title: "Copy failed" });
    }
  }

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
            description={`Referrer under "${data.referral}"`}
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
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelectedContactId(data.contactId)}
            >
              Open contact
            </Button>
            <span className="font-mono text-white/40 text-xs">
              {data.contactId}
            </span>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
            <StatCard label="Touches" value={formatNumber(touches.length)} />
            <StatCard label="Bound" value={formatNumber(bound)} />
            <StatCard label="Qualified" value={formatNumber(qualified)} />
            <StatCard
              label="Rejected"
              value={formatNumber(rejected.length)}
              hint={
                rejectedByReason
                  .slice(0, 3)
                  .map(([reason, count]) => `${reason} ${count}`)
                  .join(" · ") || undefined
              }
            />
            <StatCard
              label="Tree size"
              value={formatNumber(nodes.length)}
              hint={`to ${depth} level${depth === 1 ? "" : "s"}`}
            />
            <StatCard
              label="Tree revenue"
              value={valueString(treeValue)}
              hint={
                nodes.length > 0
                  ? `direct ${valueString(directValue)}, unweighted`
                  : undefined
              }
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Share links</CardTitle>
              <p className="text-xs text-white/40">
                The shared links minted for this referrer. Anyone landing from
                one is touched; only the referrer is credited.
              </p>
            </CardHeader>
            <CardContent>
              {links.length === 0 ? (
                <p className="text-sm text-white/40">
                  No link minted yet. One is minted the first time
                  getReferralLink() or hogsend.referral.link() runs for this
                  contact.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Link</TableHead>
                      <TableHead>Slug</TableHead>
                      <TableHead>Destination</TableHead>
                      <TableHead className="text-right">Clicks</TableHead>
                      <TableHead>Minted</TableHead>
                      <TableHead className="w-24" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {links.map((l) => {
                      const share = l.vanityUrl ?? l.url;
                      return (
                        <TableRow key={l.id}>
                          <TableCell className="font-mono text-white/80 text-xs">
                            {share}
                          </TableCell>
                          <TableCell className="font-mono text-white/60 text-xs">
                            {l.slug ?? "—"}
                          </TableCell>
                          <TableCell
                            className="max-w-[28ch] truncate font-mono text-white/60 text-xs"
                            title={l.originalUrl}
                          >
                            {l.originalUrl}
                          </TableCell>
                          <TableCell className="text-right text-white/70">
                            {formatNumber(l.clickCount)}
                          </TableCell>
                          <TableCell
                            className="text-white/60"
                            title={formatDateTime(l.createdAt)}
                          >
                            {formatRelative(l.createdAt)}
                          </TableCell>
                          <TableCell>
                            <div className="flex justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Copy share link"
                                onClick={() => copy(share)}
                              >
                                <Copy className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Open share link"
                                onClick={() =>
                                  window.open(share, "_blank", "noopener")
                                }
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Tree</CardTitle>
              <p className="text-xs text-white/40">
                Descendants to {depth} level{depth === 1 ? "" : "s"}, each under
                the person who brought them in. Every non-rejected edge,
                unweighted and unwindowed.
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
                      <TableHead>Status</TableHead>
                      <TableHead>Touched</TableHead>
                      <TableHead>Qualified</TableHead>
                      <TableHead className="text-right">Conversions</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ordered.map((n) => (
                      <TableRow
                        key={`${n.contactId}:${n.level}:${n.viaContactId}`}
                        className="cursor-pointer"
                        onClick={() => setSelectedContactId(n.contactId)}
                      >
                        <TableCell>
                          <div
                            className="flex items-center gap-2"
                            style={{ paddingLeft: `${(n.level - 1) * 20}px` }}
                          >
                            <span
                              className={
                                n.level === 1
                                  ? "text-white/30"
                                  : "text-white/20"
                              }
                            >
                              {n.level === 1 ? "•" : "└"}
                            </span>
                            <span>
                              <span className="text-white/90">
                                {displayName(n.contact, n.contactId)}
                              </span>
                              <span className="ml-2 font-mono text-[10px] text-white/35 uppercase tracking-[0.04em]">
                                L{n.level}
                              </span>
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <StatusCell status={n.status} />
                        </TableCell>
                        <TableCell
                          className="text-white/60"
                          title={formatDateTime(n.touchedAt)}
                        >
                          {formatRelative(n.touchedAt)}
                        </TableCell>
                        <TableCell
                          className="text-white/60"
                          title={
                            n.qualifiedAt ? formatDateTime(n.qualifiedAt) : ""
                          }
                        >
                          {n.qualifiedAt ? formatRelative(n.qualifiedAt) : "—"}
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
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle>Touch log</CardTitle>
                <p className="text-xs text-white/40">
                  Every touch this referrer generated, newest first, rejected
                  ones included with their reason.
                </p>
              </div>
              <div className="flex gap-2">
                <Combobox
                  ariaLabel="Status filter"
                  className="w-32"
                  placeholder="Status"
                  value={statusFilter}
                  options={STATUS_FILTERS.map((s) => ({
                    value: s,
                    label: s === "all" ? "All statuses" : s,
                  }))}
                  onChange={setStatusFilter}
                />
                <Combobox
                  ariaLabel="Source filter"
                  className="w-32"
                  placeholder="Source"
                  value={sourceFilter}
                  options={[
                    { value: "all", label: "All sources" },
                    ...sources.map((s) => ({ value: s, label: s })),
                  ]}
                  onChange={setSourceFilter}
                />
              </div>
            </CardHeader>
            <CardContent>
              {touches.length === 0 ? (
                <EmptyState
                  title="No touches"
                  description="No click, slug entry or import has recorded a touch for this referrer."
                />
              ) : visibleTouches.length === 0 ? (
                <p className="text-sm text-white/40">
                  No touch matches these filters.
                </p>
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
                    {visibleTouches.map((t) => (
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
