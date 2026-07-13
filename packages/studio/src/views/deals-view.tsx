import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  BadgePoundSterling,
  ChevronDown,
  ChevronUp,
  Clock,
  Columns3,
  HandCoins,
  TrendingUp,
} from "lucide-react";
import { useEffect, useState } from "react";
import { BarChart } from "@/components/bar-chart";
import { FunnelNotes, FunnelStages } from "@/components/funnel";
import { StatCard } from "@/components/stat-card";
import {
  CardsSkeleton,
  EmptyState,
  ErrorState,
  PageHeader,
  TableSkeleton,
} from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  type AttributionGroupBy,
  type AttributionRow,
  type ConversionListFilters,
  type ConversionRow,
  type DealListFilters,
  type DealSort,
  getAttribution,
  getConversionsStats,
  getDealsStats,
  getDealsTimeseries,
  listConversions,
  listDeals,
  qk,
} from "@/lib/admin-api";
import {
  formatCurrency,
  formatDateTime,
  formatNumber,
  formatRelative,
} from "@/lib/format";
import { DEFAULT_STAGES, stageLabel } from "@/lib/stages";
import { ContactDetailDrawer } from "./contacts/contact-detail-drawer";

/**
 * The revenue dashboard (plan §5b.2 + §5b.3): money stats, a TRUE reached-
 * stage funnel, a multi-metric daily chart, and sortable, column-configurable
 * deals/conversions tables — built to survive a thousand deals.
 */

const PAGE_SIZE = 25;

const money = (amount: number, currency: string | null) =>
  formatCurrency(amount, currency, { maximumFractionDigits: 0 });

/** Zero-filled daily series for the chart (sparse server points → bars). */
function fillDays(
  points: Array<{ date: string; value: number }>,
  days: number,
): Array<{ date: string; value: number }> {
  const byDate = new Map(points.map((p) => [p.date, p.value]));
  const out: Array<{ date: string; value: number }> = [];
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const key = d.toISOString().slice(0, 10);
    out.push({ date: key, value: byDate.get(key) ?? 0 });
  }
  return out;
}

const DISPATCH_DOT: Record<string, string> = {
  delivered: "#4ade80",
  pending: "#fbbf24",
  failed: "#f64838",
};

function DispatchChips({
  dispatches,
}: {
  dispatches: ConversionRow["dispatches"];
}) {
  if (dispatches.length === 0) {
    return <span className="text-xs text-white/35">no destinations</span>;
  }
  return (
    <span className="flex flex-wrap gap-1.5">
      {dispatches.map((d) => (
        <span
          key={d.destinationId}
          title={
            d.status === "failed" && d.lastError
              ? `${d.destinationId}: ${d.lastError}`
              : `${d.destinationId}: ${d.status} (${d.attempts} attempt${d.attempts === 1 ? "" : "s"})`
          }
          className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.02] px-2 py-0.5 text-[11px] text-white/70"
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{
              backgroundColor: DISPATCH_DOT[d.status] ?? "#ffffff40",
            }}
          />
          {d.destinationId}
        </span>
      ))}
    </span>
  );
}

function Pagination({
  offset,
  limit,
  total,
  onOffset,
}: {
  offset: number;
  limit: number;
  total: number;
  onOffset: (next: number) => void;
}) {
  if (total <= limit) return null;
  const from = offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <div className="flex items-center justify-between pt-2 text-xs text-white/50">
      <span>
        {formatNumber(from)}–{formatNumber(to)} of {formatNumber(total)}
      </span>
      <span className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={offset === 0}
          onClick={() => onOffset(Math.max(0, offset - limit))}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={to >= total}
          onClick={() => onOffset(offset + limit)}
        >
          Next
        </Button>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Interactive table plumbing: sortable headers + a column picker persisted
// per table in localStorage.
// ---------------------------------------------------------------------------

type ColumnDef<Row, Sort extends string> = {
  key: string;
  label: string;
  /** Present when the column is server-sortable. */
  sort?: Sort;
  /** Right-align (numeric). */
  numeric?: boolean;
  /** Columns that can't be hidden (the row identity). */
  always?: boolean;
  render: (row: Row) => React.ReactNode;
};

function useVisibleColumns(storageKey: string, allKeys: string[]) {
  const [hidden, setHidden] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      const parsed = raw ? (JSON.parse(raw) as string[]) : [];
      return parsed.filter((k) => allKeys.includes(k));
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(hidden));
    } catch {
      // Storage unavailable (private mode) — visibility just won't persist.
    }
  }, [storageKey, hidden]);
  const toggle = (key: string) =>
    setHidden((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  return { hidden, toggle };
}

function ColumnPicker<Row, Sort extends string>({
  columns,
  hidden,
  onToggle,
}: {
  columns: ColumnDef<Row, Sort>[];
  hidden: string[];
  onToggle: (key: string) => void;
}) {
  return (
    <details className="relative">
      <summary className="flex h-9 cursor-pointer list-none items-center gap-1.5 rounded-md border border-white/[0.08] px-3 text-sm text-white/70 transition-colors hover:text-white [&::-webkit-details-marker]:hidden">
        <Columns3 className="h-3.5 w-3.5" />
        Columns
      </summary>
      <div className="absolute right-0 z-20 mt-1 w-48 rounded-md border border-white/[0.1] bg-[#141010] p-2 shadow-xl">
        {columns.map((col) => (
          <label
            key={col.key}
            className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm ${
              col.always
                ? "cursor-not-allowed text-white/30"
                : "cursor-pointer text-white/80 hover:bg-white/[0.04]"
            }`}
          >
            <input
              type="checkbox"
              checked={!hidden.includes(col.key)}
              disabled={col.always}
              onChange={() => onToggle(col.key)}
              className="accent-accent"
            />
            {col.label}
          </label>
        ))}
      </div>
    </details>
  );
}

function InteractiveTable<Row extends { id: string }, Sort extends string>({
  columns,
  hidden,
  rows,
  sort,
  dir,
  onSort,
}: {
  columns: ColumnDef<Row, Sort>[];
  hidden: string[];
  rows: Row[];
  sort: Sort;
  dir: "asc" | "desc";
  onSort: (sort: Sort) => void;
}) {
  const visible = columns.filter((c) => c.always || !hidden.includes(c.key));
  return (
    <div className="overflow-x-auto rounded-md border border-white/[0.08]">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-white/[0.08] text-left text-xs uppercase tracking-wide text-white/40">
            {visible.map((col) => (
              <th
                key={col.key}
                className={`px-3 py-2.5 font-medium ${col.numeric ? "text-right" : ""}`}
              >
                {col.sort ? (
                  <button
                    type="button"
                    onClick={() => onSort(col.sort as Sort)}
                    className={`inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-white ${
                      sort === col.sort ? "text-white" : ""
                    }`}
                  >
                    {col.label}
                    {sort === col.sort ? (
                      dir === "asc" ? (
                        <ChevronUp className="h-3 w-3" />
                      ) : (
                        <ChevronDown className="h-3 w-3" />
                      )
                    ) : null}
                  </button>
                ) : (
                  col.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className="border-b border-white/[0.04] last:border-b-0 hover:bg-white/[0.02]"
            >
              {visible.map((col) => (
                <td
                  key={col.key}
                  className={`px-3 py-2.5 ${col.numeric ? "text-right tabular-nums" : ""}`}
                >
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Contact cell that opens the full contact drawer — deals ARE contacts. */
function ContactCell({
  email,
  contactId,
  fallback,
  onOpen,
}: {
  email: string | null;
  contactId: string;
  fallback: string;
  onOpen: (contactId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(contactId)}
      className="max-w-[240px] truncate text-left text-white/90 underline-offset-2 transition-colors hover:text-accent hover:underline"
    >
      {email ?? fallback}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Deals tab
// ---------------------------------------------------------------------------

function DealsTable({
  stages,
  funnel,
  onOpenContact,
}: {
  stages: string[];
  funnel?: string;
  onOpenContact: (contactId: string) => void;
}) {
  const [stage, setStage] = useState("");
  const [provider, setProvider] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [minValue, setMinValue] = useState("");
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<DealSort>("lastStageAt");
  const [dir, setDir] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    const t = window.setTimeout(() => {
      setSearch(searchInput.trim());
      setOffset(0);
    }, 300);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  const toggleSort = (next: DealSort) => {
    if (next === sort) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSort(next);
      setDir("desc");
    }
    setOffset(0);
  };

  const columns: ColumnDef<
    Awaited<ReturnType<typeof listDeals>>["deals"][number],
    DealSort
  >[] = [
    {
      key: "contact",
      label: "Contact",
      sort: "contactEmail",
      always: true,
      render: (deal) => (
        <ContactCell
          email={deal.contactEmail}
          contactId={deal.contactId}
          fallback={deal.externalId}
          onOpen={onOpenContact}
        />
      ),
    },
    {
      key: "stage",
      label: "Stage",
      sort: "stage",
      render: (deal) => (
        <Badge
          variant={
            deal.canonicalStage === "lost"
              ? "destructive"
              : deal.soldAt
                ? "default"
                : "outline"
          }
        >
          {stageLabel(deal.canonicalStage)}
        </Badge>
      ),
    },
    {
      key: "value",
      label: "Value",
      sort: "value",
      numeric: true,
      render: (deal) =>
        deal.value !== null ? (
          <span className="text-white/90">
            {money(deal.value, deal.currency)}
          </span>
        ) : (
          "—"
        ),
    },
    {
      key: "provider",
      label: "Provider",
      sort: "provider",
      render: (deal) => <span className="text-white/60">{deal.provider}</span>,
    },
    {
      key: "pipeline",
      label: "Pipeline",
      render: (deal) => (
        <span className="text-white/50">{deal.pipelineId ?? "—"}</span>
      ),
    },
    {
      key: "nativeStage",
      label: "Native stage",
      render: (deal) => (
        <span className="text-white/50">{deal.stageId ?? "—"}</span>
      ),
    },
    {
      key: "quoted",
      label: "Quoted",
      sort: "quotedAt",
      render: (deal) => (
        <span className="text-white/50">
          {deal.quotedAt ? formatRelative(deal.quotedAt) : "—"}
        </span>
      ),
    },
    {
      key: "sold",
      label: "Sold",
      sort: "soldAt",
      render: (deal) => (
        <span className="text-white/50">
          {deal.soldAt ? formatRelative(deal.soldAt) : "—"}
        </span>
      ),
    },
    {
      key: "created",
      label: "Created",
      sort: "createdAt",
      render: (deal) => (
        <span className="text-white/50">{formatRelative(deal.createdAt)}</span>
      ),
    },
    {
      key: "lastActivity",
      label: "Last activity",
      sort: "lastStageAt",
      render: (deal) => (
        <span className="text-white/50">
          {deal.lastStageAt ? formatDateTime(deal.lastStageAt) : "—"}
        </span>
      ),
    },
  ];
  const { hidden, toggle } = useVisibleColumns(
    "hs-studio:deals-columns",
    columns.map((c) => c.key),
  );

  const filters: DealListFilters = {
    stage: stage || undefined,
    provider: provider || undefined,
    funnel,
    search: search || undefined,
    minValue: minValue ? Number(minValue) : undefined,
    sort,
    dir,
    limit: PAGE_SIZE,
    offset,
  };
  const query = useQuery({
    queryKey: qk.deals(filters),
    queryFn: () => listDeals(filters),
    placeholderData: keepPreviousData,
  });
  const deals = query.data?.deals ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <Input
          className="w-56"
          placeholder="Search contact email"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        <div className="w-40">
          <Select
            value={stage}
            onChange={(e) => {
              setStage(e.target.value);
              setOffset(0);
            }}
            aria-label="Filter by stage"
          >
            <option value="">All stages</option>
            {stages.map((s) => (
              <option key={s} value={s}>
                {stageLabel(s)}
              </option>
            ))}
          </Select>
        </div>
        <Input
          className="w-36"
          placeholder="Provider"
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value);
            setOffset(0);
          }}
        />
        <Input
          className="w-32"
          placeholder="Min value"
          inputMode="numeric"
          value={minValue}
          onChange={(e) => {
            setMinValue(e.target.value.replace(/[^0-9.]/g, ""));
            setOffset(0);
          }}
        />
        <div className="ml-auto">
          <ColumnPicker columns={columns} hidden={hidden} onToggle={toggle} />
        </div>
      </div>

      {query.isPending ? (
        <TableSkeleton rows={8} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : deals.length === 0 ? (
        <EmptyState
          title="No deals match"
          description="Loosen the filters, or wait for the next CRM stage change."
        />
      ) : (
        <>
          <InteractiveTable
            columns={columns}
            hidden={hidden}
            rows={deals}
            sort={sort}
            dir={dir}
            onSort={toggleSort}
          />
          <Pagination
            offset={offset}
            limit={PAGE_SIZE}
            total={query.data?.total ?? 0}
            onOffset={setOffset}
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conversions tab
// ---------------------------------------------------------------------------

type ConversionSort = NonNullable<ConversionListFilters["sort"]>;

function ConversionsTable({
  onOpenContact,
}: {
  onOpenContact: (contactId: string) => void;
}) {
  const [definitionId, setDefinitionId] = useState("");
  const [dispatchStatus, setDispatchStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<ConversionSort>("occurredAt");
  const [dir, setDir] = useState<"asc" | "desc">("desc");

  const statsQuery = useQuery({
    queryKey: qk.conversionsStats,
    queryFn: getConversionsStats,
  });

  const toggleSort = (next: ConversionSort) => {
    if (next === sort) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSort(next);
      setDir("desc");
    }
    setOffset(0);
  };

  const columns: ColumnDef<ConversionRow, ConversionSort>[] = [
    {
      key: "when",
      label: "When",
      sort: "occurredAt",
      always: true,
      render: (row) => (
        <span className="whitespace-nowrap text-white/50">
          {formatDateTime(row.occurredAt)}
        </span>
      ),
    },
    {
      key: "definition",
      label: "Conversion",
      sort: "definitionId",
      render: (row) => <Badge variant="secondary">{row.definitionId}</Badge>,
    },
    {
      key: "contact",
      label: "Contact",
      render: (row) => (
        <ContactCell
          email={row.contactEmail}
          contactId={row.contactId}
          fallback={row.contactId}
          onOpen={onOpenContact}
        />
      ),
    },
    {
      key: "value",
      label: "Value",
      sort: "value",
      numeric: true,
      render: (row) =>
        row.value !== null ? (
          <span className="text-white/90">
            {money(row.value, row.currency)}
          </span>
        ) : (
          "—"
        ),
    },
    {
      key: "destinations",
      label: "Destinations",
      render: (row) => <DispatchChips dispatches={row.dispatches} />,
    },
  ];
  const { hidden, toggle } = useVisibleColumns(
    "hs-studio:conversions-columns",
    columns.map((c) => c.key),
  );

  const filters: ConversionListFilters = {
    definitionId: definitionId || undefined,
    dispatchStatus: (dispatchStatus || undefined) as
      | "pending"
      | "delivered"
      | "failed"
      | undefined,
    sort,
    dir,
    limit: PAGE_SIZE,
    offset,
  };
  const query = useQuery({
    queryKey: qk.conversions(filters),
    queryFn: () => listConversions(filters),
    placeholderData: keepPreviousData,
  });
  const rows = query.data?.conversions ?? [];
  const definitions = statsQuery.data?.definitions ?? [];
  const destinations = statsQuery.data?.destinations ?? [];

  return (
    <div className="space-y-3">
      {destinations.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-white/50">
          <span className="eyebrow text-white/35">Delivery health</span>
          {destinations.map((d) => (
            <span
              key={d.destinationId}
              className="inline-flex items-center gap-2 tabular-nums"
            >
              <span className="text-white/70">{d.destinationId}</span>
              <span style={{ color: DISPATCH_DOT.delivered }}>
                {formatNumber(d.delivered)} delivered
              </span>
              {d.pending > 0 ? (
                <span style={{ color: DISPATCH_DOT.pending }}>
                  {formatNumber(d.pending)} pending
                </span>
              ) : null}
              {d.failed > 0 ? (
                <span style={{ color: DISPATCH_DOT.failed }}>
                  {formatNumber(d.failed)} failed
                </span>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-56">
          <Select
            value={definitionId}
            onChange={(e) => {
              setDefinitionId(e.target.value);
              setOffset(0);
            }}
            aria-label="Filter by conversion point"
          >
            <option value="">All conversion points</option>
            {definitions.map((d) => (
              <option key={d.definitionId} value={d.definitionId}>
                {d.definitionId} ({formatNumber(d.count30d)} / 30d)
              </option>
            ))}
          </Select>
        </div>
        <div className="w-44">
          <Select
            value={dispatchStatus}
            onChange={(e) => {
              setDispatchStatus(e.target.value);
              setOffset(0);
            }}
            aria-label="Filter by delivery status"
          >
            <option value="">Any delivery status</option>
            <option value="pending">Pending</option>
            <option value="delivered">Delivered</option>
            <option value="failed">Failed</option>
          </Select>
        </div>
        <div className="ml-auto">
          <ColumnPicker columns={columns} hidden={hidden} onToggle={toggle} />
        </div>
      </div>

      {query.isPending ? (
        <TableSkeleton rows={8} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No conversions yet"
          description="Declare conversion points (defineConversion) and fired instances land here with their ad-platform delivery state."
        />
      ) : (
        <>
          <InteractiveTable
            columns={columns}
            hidden={hidden}
            rows={rows}
            sort={sort}
            dir={dir}
            onSort={toggleSort}
          />
          <Pagination
            offset={offset}
            limit={PAGE_SIZE}
            total={query.data?.total ?? 0}
            onOffset={setOffset}
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Attribution tab — the credit ledger, pivoted (§6.2)
// ---------------------------------------------------------------------------

const MODEL_LABELS: Record<string, string> = {
  first: "First touch",
  last: "Last touch (headline)",
  lastNonDirect: "Last non-form",
  linear: "Linear",
  timeDecay: "Time decay",
  positionU: "Position (U)",
  positionW: "Position (W)",
  blended: "Blended",
};
const MODEL_ORDER = Object.keys(MODEL_LABELS);

const DIMENSION_LABELS: Record<AttributionGroupBy, string> = {
  channel: "By channel",
  journey: "By journey",
  campaign: "By campaign",
  template: "By template",
};

function AttributionPanel() {
  const [model, setModel] = useState("blended");
  const [dimension, setDimension] = useState<AttributionGroupBy>("channel");
  // undefined = all conversion points together.
  const [definition, setDefinition] = useState<string | undefined>();
  const query = useQuery({
    queryKey: qk.attribution(90, definition, dimension),
    queryFn: () => getAttribution(90, definition, dimension),
    placeholderData: keepPreviousData,
  });
  const statsQuery = useQuery({
    queryKey: qk.conversionsStats,
    queryFn: getConversionsStats,
  });
  const definitions = statsQuery.data?.definitions ?? [];

  const rows = query.data?.rows ?? [];
  // One currency at a time — pick the biggest book, never cross-sum.
  const byCurrency = new Map<string | null, number>();
  for (const row of rows) {
    byCurrency.set(
      row.currency,
      (byCurrency.get(row.currency) ?? 0) + row.value,
    );
  }
  const currency =
    [...byCurrency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const scoped = rows.filter((r) => r.currency === currency);
  // The grouped key: `key` since the groupBy engines; older engines only
  // ever return channel rows. Null key = credits with no scope on this
  // dimension (a transactional click under "By journey").
  const keyOf = (r: AttributionRow) => r.key ?? r.channel ?? null;
  const keys = [...new Set(scoped.map(keyOf))].sort((a, b) =>
    a === null ? 1 : b === null ? -1 : a.localeCompare(b),
  );
  const labelOf = (k: string | null) =>
    k === null
      ? `No ${dimension === "channel" ? "channel" : dimension}`
      : (scoped.find((r) => keyOf(r) === k)?.label ?? k);
  // Keep the model picker usable while empty/pending — offer the full
  // catalog until the ledger says which models exist.
  const models = scoped.length
    ? MODEL_ORDER.filter((m) => scoped.some((r) => r.model === m))
    : MODEL_ORDER;
  const cell = (m: string, k: string | null) =>
    scoped.find((r) => r.model === m && keyOf(r) === k);
  const selected = keys
    .map((k) => ({ key: k, row: cell(model, k) }))
    .sort((a, b) => (b.row?.value ?? 0) - (a.row?.value ?? 0));

  // Coverage: the ledger only divides conversions that had a touchpoint
  // path. Surface the rest as an explicit Unattributed row so the tab's
  // total reconciles with the conversion value actually fired.
  const coverage = query.data?.totals?.find((t) => t.currency === currency);
  const unattributedValue = Math.max(
    0,
    (coverage?.value ?? 0) - (coverage?.attributedValue ?? 0),
  );
  const unattributedCount =
    (coverage?.conversions ?? 0) - (coverage?.attributedConversions ?? 0);
  const maxValue = Math.max(
    ...selected.map((s) => s.row?.value ?? 0),
    unattributedValue,
    1,
  );

  const fired =
    query.data?.totals?.reduce((sum, t) => sum + t.conversions, 0) ?? 0;

  // Overlap (§2.3): what per-scope full-credit reporting would double-count.
  const overlap = query.data?.overlap?.find((o) => o.currency === currency);
  const doubleCounted = overlap ? overlap.scopeSummedValue - overlap.value : 0;

  // The scope controls stay mounted through every state — an empty scope
  // (e.g. a conversion point whose conversions are all direct) must leave
  // the user a way back to "All conversion points".
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <div className="w-52">
            <Select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              aria-label="Attribution model"
            >
              {models.map((m) => (
                <option key={m} value={m}>
                  {MODEL_LABELS[m] ?? m}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-40">
            <Select
              value={dimension}
              onChange={(e) =>
                setDimension(e.target.value as AttributionGroupBy)
              }
              aria-label="Group by"
            >
              {(Object.keys(DIMENSION_LABELS) as AttributionGroupBy[]).map(
                (d) => (
                  <option key={d} value={d}>
                    {DIMENSION_LABELS[d]}
                  </option>
                ),
              )}
            </Select>
          </div>
          {definitions.length > 1 && (
            <div className="w-52">
              <Select
                value={definition ?? ""}
                onChange={(e) => setDefinition(e.target.value || undefined)}
                aria-label="Conversion point"
              >
                <option value="">All conversion points</option>
                {definitions.map((d) => (
                  <option key={d.definitionId} value={d.definitionId}>
                    {d.definitionId}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>
        <span className="text-xs text-white/40">
          Last {query.data?.days} days
          {currency ? ` · ${currency}` : ""}
          {coverage
            ? ` · ${money(coverage.attributedValue, currency)} of ${money(coverage.value, currency)} attributed (${coverage.attributedConversions} of ${coverage.conversions} conversions)`
            : " · all models computed at conversion time"}
        </span>
      </div>

      {query.isPending ? (
        <TableSkeleton rows={6} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No attribution credits yet"
          description={
            fired > 0
              ? `${fired} conversion${fired === 1 ? "" : "s"} fired in the last 90 days, but none had touchpoints (ad clicks, email/SMS clicks, lead forms) in the lookback window to credit.`
              : "Credits are written when a conversion point fires for a contact with touchpoints (ad clicks, email/SMS clicks, lead forms) in its lookback window."
          }
        />
      ) : (
        <>
          <div className="space-y-2.5">
            {selected.map(({ key, row }) => (
              <div key={key ?? "__none__"} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span
                    className={
                      dimension === "channel"
                        ? "text-white/70 capitalize"
                        : "text-white/70"
                    }
                  >
                    {labelOf(key)}
                  </span>
                  <span className="flex items-baseline gap-3 tabular-nums">
                    <span className="text-xs text-white/45">
                      {(row?.conversions ?? 0).toFixed(1)} conversions
                    </span>
                    <span className="font-medium text-white/90">
                      {money(row?.value ?? 0, currency)}
                    </span>
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                  <div
                    className="h-full rounded-full bg-accent/70"
                    style={{
                      width: `${((row?.value ?? 0) / maxValue) * 100}%`,
                    }}
                  />
                </div>
              </div>
            ))}
            {unattributedCount > 0 && (
              <div className="space-y-1">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="text-white/45">Unattributed</span>
                  <span className="flex items-baseline gap-3 tabular-nums">
                    <span className="text-xs text-white/45">
                      {unattributedCount} conversion
                      {unattributedCount === 1 ? "" : "s"}
                    </span>
                    <span className="font-medium text-white/60">
                      {money(unattributedValue, currency)}
                    </span>
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                  <div
                    className="h-full rounded-full bg-white/20"
                    style={{
                      width: `${(unattributedValue / maxValue) * 100}%`,
                    }}
                  />
                </div>
                <p className="text-xs text-white/35">
                  Conversions with no touchpoints in the lookback window —
                  direct, imported, or fired before tracking was live. Models
                  only divide what has a path.
                </p>
              </div>
            )}
            {overlap && overlap.multiScopeConversions > 0 && (
              <p className="text-xs text-white/35">
                Overlap: {overlap.multiScopeConversions} of{" "}
                {overlap.conversions} attributed conversion
                {overlap.conversions === 1 ? " was" : "s were"} touched by more
                than one {dimension === "channel" ? "channel" : dimension}.
                Giving each full credit would report{" "}
                {money(overlap.scopeSummedValue, currency)} instead of the real{" "}
                {money(overlap.value, currency)} —{" "}
                {money(doubleCounted, currency)} counted twice. The fractional
                models above already split it honestly.
              </p>
            )}
          </div>

          <div className="overflow-x-auto rounded-md border border-white/[0.08]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.08] text-left text-xs uppercase tracking-wide text-white/40">
                  <th className="px-3 py-2.5 font-medium capitalize">
                    {dimension}
                  </th>
                  {models.map((m) => (
                    <th
                      key={m}
                      className={`px-3 py-2.5 text-right font-medium ${
                        m === model ? "text-white" : ""
                      }`}
                    >
                      {MODEL_LABELS[m] ?? m}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr
                    key={k ?? "__none__"}
                    className="border-b border-white/[0.04] last:border-b-0 hover:bg-white/[0.02]"
                  >
                    <td
                      className={`px-3 py-2.5 text-white/70 ${
                        dimension === "channel" ? "capitalize" : ""
                      }`}
                    >
                      {labelOf(k)}
                    </td>
                    {models.map((m) => (
                      <td
                        key={m}
                        className={`px-3 py-2.5 text-right tabular-nums ${
                          m === model ? "text-white/90" : "text-white/50"
                        }`}
                      >
                        {money(cell(m, k)?.value ?? 0, currency)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {model === "last" && (
            <p className="text-xs text-white/35">
              The headline number: the single most recent qualifying touch takes
              full credit — how Klaviyo, Braze and Customer.io report
              "attributed revenue", so it's the comparable figure when
              migrating. The fractional models beside it are the honest split.
            </p>
          )}
          <p className="text-xs text-white/35">
            Same conversions, eight opinions about who earned them — a channel
            that only looks good under one model is telling you something.
          </p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The dashboard
// ---------------------------------------------------------------------------

type ChartMetric = "soldRevenue" | "soldCount" | "quotedCount" | "createdCount";

const CHART_METRICS: Array<{ key: ChartMetric; label: string }> = [
  { key: "soldRevenue", label: "Sold revenue" },
  { key: "soldCount", label: "Deals sold" },
  { key: "quotedCount", label: "Quotes issued" },
  { key: "createdCount", label: "New deals" },
];

export function DealsView() {
  const [tab, setTab] = useState<"deals" | "conversions" | "attribution">(
    "deals",
  );
  const [metric, setMetric] = useState<ChartMetric>("soldRevenue");
  const [openContactId, setOpenContactId] = useState<string | null>(null);
  // undefined = the engine's default funnel.
  const [funnel, setFunnel] = useState<string | undefined>(undefined);

  const statsQuery = useQuery({
    queryKey: qk.dealsStats(funnel),
    queryFn: () => getDealsStats(funnel),
  });
  const timeseriesQuery = useQuery({
    queryKey: qk.dealsTimeseries(60, funnel),
    queryFn: () => getDealsTimeseries(60, funnel),
  });

  const funnelCatalog = statsQuery.data?.funnels ?? [];
  const primary = statsQuery.data?.currencies[0];
  // Column/filter order = the deployment's configured ladder (from /stats).
  const stageOrder = statsQuery.data?.stageOrder ?? DEFAULT_STAGES;
  const funnelStages = stageOrder.filter((s) => s !== "lost");
  const lostCount = statsQuery.data?.stages.lost ?? 0;
  // TRUE funnel counts (reached-or-beyond); older engines fall back to the
  // current-position counts.
  const funnelCounts =
    statsQuery.data?.reached ?? statsQuery.data?.stages ?? {};

  const ts = timeseriesQuery.data;
  const revenueSeries =
    ts?.revenue.find((c) => c.currency === (primary?.currency ?? null)) ??
    ts?.revenue[0];
  const metricPoints =
    metric === "soldRevenue"
      ? (revenueSeries?.points ?? [])
      : metric === "soldCount"
        ? (ts?.counts.sold ?? [])
        : metric === "quotedCount"
          ? (ts?.counts.quoted ?? [])
          : (ts?.counts.created ?? []);
  const chartData = fillDays(metricPoints, 60);
  const chartHasData = metricPoints.length > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Deals"
        description="The revenue dashboard — every CRM deal and fired conversion, with the money front and center."
      />

      {funnelCatalog.length > 1 ? (
        <div className="flex flex-wrap gap-1">
          {funnelCatalog.map((f) => {
            const active =
              (funnel ?? statsQuery.data?.funnelId ?? "default") === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setFunnel(f.id)}
                className={`rounded-full border px-3.5 py-1.5 text-sm transition-colors ${
                  active
                    ? "border-accent/50 bg-accent-tint text-white"
                    : "border-white/[0.08] text-white/55 hover:text-white/85"
                }`}
              >
                {f.name ?? stageLabel(f.id)}
              </button>
            );
          })}
        </div>
      ) : null}

      {statsQuery.isPending ? (
        <CardsSkeleton count={4} />
      ) : statsQuery.isError ? (
        <ErrorState
          error={statsQuery.error}
          onRetry={() => statsQuery.refetch()}
        />
      ) : primary ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Revenue (30d)"
            value={money(primary.soldRevenue30d, primary.currency)}
            hint={`${formatNumber(primary.soldCount30d)} deals sold`}
            icon={BadgePoundSterling}
          />
          <StatCard
            label="Revenue (lifetime)"
            value={money(primary.soldRevenueLifetime, primary.currency)}
            hint={`${formatNumber(primary.soldCountLifetime)} deals sold`}
            icon={TrendingUp}
          />
          <StatCard
            label="Open pipeline"
            value={money(primary.openPipelineValue, primary.currency)}
            hint={`${formatNumber(primary.openPipelineCount)} open deals`}
            icon={HandCoins}
          />
          <StatCard
            label="Avg order / cycle"
            value={
              primary.averageOrderValue !== null
                ? money(primary.averageOrderValue, primary.currency)
                : "—"
            }
            hint={
              statsQuery.data.avgTimeToCloseHours !== null
                ? `${formatNumber(
                    Math.round(statsQuery.data.avgTimeToCloseHours / 24),
                  )}d avg time to close`
                : undefined
            }
            icon={Clock}
          />
        </div>
      ) : (
        <EmptyState
          title="No deals yet"
          description="Wire a CRM provider (crm.providers + stageMaps) and stage changes will land here with their values."
        />
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>
                Last 60 days
                {metric === "soldRevenue" && revenueSeries?.currency
                  ? ` (${revenueSeries.currency})`
                  : ""}
              </CardTitle>
              <div className="flex gap-1">
                {CHART_METRICS.map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => setMetric(m.key)}
                    className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                      metric === m.key
                        ? "border-accent/50 bg-accent-tint text-white"
                        : "border-white/[0.08] text-white/50 hover:text-white/80"
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {timeseriesQuery.isError ? (
              <ErrorState
                error={timeseriesQuery.error}
                onRetry={() => timeseriesQuery.refetch()}
              />
            ) : chartHasData ? (
              <BarChart
                data={chartData}
                height={180}
                label={
                  CHART_METRICS.find(
                    (m) => m.key === metric,
                  )?.label.toLowerCase() ?? "value"
                }
              />
            ) : (
              <div className="flex h-[180px] items-center justify-center text-sm text-white/50">
                Nothing in the last 60 days
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Pipeline funnel</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <FunnelStages
              variant="rows"
              ariaLabel="Deals reached-stage funnel"
              stages={funnelStages.map((s) => ({
                key: s,
                label: stageLabel(s),
                value: funnelCounts[s] ?? 0,
              }))}
            />
            {lostCount > 0 ? (
              <FunnelNotes
                label="Left the funnel"
                items={[
                  {
                    key: "lost",
                    label: "Lost",
                    value: lostCount,
                    color: "#f64838",
                  },
                ]}
              />
            ) : null}
          </CardContent>
        </Card>
      </div>

      <div className="flex gap-1 border-b border-white/[0.08]">
        {(
          [
            ["deals", "Deals"],
            ["conversions", "Conversions"],
            ["attribution", "Attribution"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm transition-colors ${
              tab === key
                ? "border-accent text-white"
                : "border-transparent text-white/50 hover:text-white/80"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "deals" ? (
        // Explicit funnel scope even before any pill click — the stats cards
        // above are default-scoped, so the table must be too.
        <DealsTable
          key={funnel ?? statsQuery.data?.funnelId ?? "default"}
          stages={stageOrder}
          funnel={funnel ?? statsQuery.data?.funnelId ?? "default"}
          onOpenContact={setOpenContactId}
        />
      ) : tab === "conversions" ? (
        <ConversionsTable onOpenContact={setOpenContactId} />
      ) : (
        <AttributionPanel />
      )}

      <ContactDetailDrawer
        contactId={openContactId}
        onClose={() => setOpenContactId(null)}
      />
    </div>
  );
}
