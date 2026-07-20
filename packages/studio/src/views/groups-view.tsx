import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowUp,
  Building2,
  Check,
  ChevronDown,
  Columns3,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  TableSkeleton,
} from "@/components/states";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type AdminGroup,
  type GroupFx,
  type GroupListFilters,
  type GroupSort,
  listGroups,
  listGroupTypes,
  qk,
} from "@/lib/admin-api";
import {
  formatAmountWithCode,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatNumber,
  truncate,
} from "@/lib/format";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 25;

/** Column visibility survives a reload — a per-browser preference, not state. */
const COLUMNS_STORAGE_KEY = "hogsend-studio:groups-columns";

/**
 * The fixed columns, in render order. The Group column is deliberately absent:
 * it identifies the row, so it is always on and never offered in the menu.
 */
const CORE_COLUMNS = [
  { id: "type", label: "Type" },
  { id: "members", label: "Members" },
  { id: "revenue", label: "Revenue" },
  { id: "firstSeen", label: "First seen" },
  { id: "lastSeen", label: "Last seen" },
] as const;

/** Property columns share the visibility set with the core ones — namespaced so
 * a property literally called "members" can't collide with the core column. */
function propColumnId(key: string): string {
  return `prop:${key}`;
}

function defaultVisibleColumns(): Set<string> {
  // Core columns on, property columns off.
  return new Set(CORE_COLUMNS.map((c) => c.id));
}

function loadVisibleColumns(): Set<string> {
  try {
    const raw = localStorage.getItem(COLUMNS_STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return new Set(
          parsed.filter((v): v is string => typeof v === "string"),
        );
      }
    }
  } catch {
    // Blocked/garbled storage (privacy mode, a hand-edited value) — defaults.
  }
  return defaultVisibleColumns();
}

function saveVisibleColumns(visible: Set<string>): void {
  try {
    localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify([...visible]));
  } catch {
    // Best-effort persistence; the session's choices still stand.
  }
}

/** A property value in a table cell: scalars render, containers collapse. */
function renderPropertyValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value ? truncate(value, 32) : "—";
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  // Objects/arrays have no honest one-line form — the detail view shows them.
  return "…";
}

/**
 * The money cell — three modes, and NEVER a client-side sum across currencies
 * (the revenue spine's law: a GBP deal and a USD deal don't add).
 *
 *  1. FX lens on, group convertible → the base-currency figure, prefixed "≈"
 *     because it is a conversion, not a ledger number.
 *  2. FX lens on, group NOT convertible (some currency has no rate) → an em
 *     dash, titled, rather than a partial sum that would show the account as
 *     smaller than it is.
 *  3. FX lens off → the per-currency totals themselves, biggest first (the
 *     server orders them), the tail collapsed to "+n".
 */
function RevenueCell({ row, fx }: { row: AdminGroup; fx: GroupFx | null }) {
  if (fx) {
    if (row.revenueBase === null) {
      return (
        <span
          className="text-white/40"
          title={`Unconvertible: this group holds money in a currency with no ${fx.baseCurrency} rate, and a partial sum would understate it.`}
        >
          —
        </span>
      );
    }
    return (
      <span className="text-white/80">
        <span className="text-white/40">≈ </span>
        {formatCurrency(row.revenueBase, fx.baseCurrency, {
          maximumFractionDigits: 0,
        })}
      </span>
    );
  }

  const parts = row.revenueTotals.map((t) =>
    formatAmountWithCode(t.total, t.currency),
  );
  if (parts.length === 0) return <span className="text-white/40">—</span>;

  const rest = parts.length - 2;
  return (
    <span className="text-white/80" title={parts.join(" · ")}>
      {parts.slice(0, 2).join(" · ")}
      {rest > 0 ? <span className="text-white/40"> +{rest}</span> : null}
    </span>
  );
}

/**
 * The "Columns" menu — core columns plus whatever property keys this page's
 * groups actually carry (properties are an open bag, so the options are derived
 * from the data, not declared). Same outside-click/Escape idiom as SplitButton.
 */
function ColumnsMenu({
  propertyKeys,
  visible,
  onToggle,
}: {
  propertyKeys: string[];
  visible: Set<string>;
  onToggle: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target;
      if (
        rootRef.current &&
        target instanceof globalThis.Node &&
        !rootRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const item = (id: string, label: string, mono?: boolean) => (
    <button
      key={id}
      type="button"
      onClick={() => onToggle(id)}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/80 text-xs transition-colors hover:bg-white/5"
    >
      <span className="inline-flex h-3.5 w-3.5 items-center justify-center">
        {visible.has(id) ? <Check className="h-3 w-3 text-accent" /> : null}
      </span>
      <span className={mono ? "truncate font-mono" : "truncate"}>{label}</span>
    </button>
  );

  return (
    <div ref={rootRef} className="relative">
      <Button
        variant="outline"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Columns3 className="h-3.5 w-3.5" />
        Columns
        <ChevronDown className="h-3.5 w-3.5" />
      </Button>
      {open ? (
        <div className="absolute right-0 top-full z-20 mt-1 max-h-80 w-60 overflow-y-auto rounded-md border border-hairline-faint bg-raised py-1 shadow-lg">
          {CORE_COLUMNS.map((c) => item(c.id, c.label))}
          {propertyKeys.length > 0 ? (
            <>
              <div className="border-hairline-faint border-t px-3 pt-2 pb-1 text-[10px] text-white/35 uppercase tracking-[0.08em]">
                Properties
              </div>
              {propertyKeys.map((key) => item(propColumnId(key), key, true))}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Observe-only Groups view — account/team/company-level records tracked from
 * events + memberships. Read-only over HTTP: groups are authored in the data
 * plane, so there is intentionally NO create/edit-group UI. Each row opens the
 * group detail.
 *
 * A deployment can carry thousands of groups, so search, sort, and paging are
 * all SERVER-driven (the list endpoint's `search`/`sort`/`order`/`offset`) —
 * nothing here re-orders or re-filters a page client-side, which would rank a
 * page-local lie. Mirrors contacts-view.tsx (debounced search) and
 * sends-view.tsx (sortable heads + pager).
 */
export function GroupsView() {
  const navigate = useNavigate();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [groupType, setGroupType] = useState("");
  const [sort, setSort] = useState<GroupSort>("lastSeen");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [offset, setOffset] = useState(0);
  const [visible, setVisible] = useState<Set<string>>(loadVisibleColumns);

  // Debounce the search box so we don't fire a request per keystroke; a new
  // search starts at page one.
  useEffect(() => {
    const t = window.setTimeout(() => {
      setSearch(searchInput.trim());
      setOffset(0);
    }, 300);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  const filters: GroupListFilters = {
    limit: PAGE_SIZE,
    offset,
    groupType: groupType || undefined,
    search: search || undefined,
    sort,
    order,
  };

  const query = useQuery({
    queryKey: qk.groups(filters),
    queryFn: () => listGroups(filters),
    placeholderData: keepPreviousData,
  });

  // The distinct-type vocabulary feeding the filter — one cached fetch.
  const typesQuery = useQuery({
    queryKey: qk.groupTypes,
    queryFn: listGroupTypes,
    staleTime: 60_000,
  });
  const groupTypes = typesQuery.data?.types ?? [];

  const rows = useMemo(() => query.data?.groups ?? [], [query.data]);
  const total = query.data?.total ?? 0;
  const fx = query.data?.fx ?? null;
  const hasMore = offset + rows.length < total;

  // The optional columns on offer: every property key this page's groups carry.
  const propertyKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const row of rows) {
      for (const key of Object.keys(row.properties)) keys.add(key);
    }
    return [...keys].sort();
  }, [rows]);

  // Only render a property column the current page can actually fill.
  const propertyColumns = propertyKeys.filter((key) =>
    visible.has(propColumnId(key)),
  );

  function toggleColumn(id: string) {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveVisibleColumns(next);
      return next;
    });
  }

  function toggleSort(column: GroupSort) {
    if (sort === column) {
      setOrder((o) => (o === "asc" ? "desc" : "asc"));
    } else {
      setSort(column);
      setOrder("desc");
    }
    setOffset(0);
  }

  function SortHead({
    column,
    label,
    hint,
    align,
  }: {
    column: GroupSort;
    label: string;
    /** A muted second line under the label (e.g. the FX lens's basis). */
    hint?: string;
    align?: "right";
  }) {
    const active = sort === column;
    return (
      <TableHead className={cn(align === "right" && "text-right")}>
        <button
          type="button"
          className={cn(
            "inline-flex flex-col transition-colors duration-200 hover:text-white",
            align === "right" ? "items-end" : "items-start",
          )}
          onClick={() => toggleSort(column)}
        >
          <span className="inline-flex items-center gap-1">
            {label}
            {active ? (
              order === "asc" ? (
                <ArrowUp className="h-3 w-3" />
              ) : (
                <ArrowDown className="h-3 w-3" />
              )
            ) : null}
          </span>
          {hint ? (
            <span className="font-normal text-[10px] text-white/35 normal-case tracking-normal">
              {hint}
            </span>
          ) : null}
        </button>
      </TableHead>
    );
  }

  const revenueHint = fx
    ? `≈ ${fx.baseCurrency}${fx.asOf ? ` · rates as of ${formatDate(fx.asOf)}` : ""}`
    : undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Groups"
        description="Account-, team-, and company-level records tracked from events and memberships — observe only, authoring stays in the data plane."
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex w-full max-w-xl flex-1 items-center gap-3">
          <div className="relative w-full max-w-sm">
            <Search
              className="-translate-y-1/2 absolute top-1/2 left-3 h-4 w-4 text-white/40"
              strokeWidth={1.5}
            />
            <Input
              placeholder="Search by group key or name…"
              className="pl-9"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
          {/* One type = nothing to narrow; skip the dropdown entirely. */}
          {groupTypes.length > 1 || groupType ? (
            <Combobox
              ariaLabel="Group type"
              className="w-44 shrink-0"
              value={groupType}
              placeholder="All types"
              options={groupTypes.map((t) => ({
                value: t.groupType,
                label: t.groupType,
                hint: formatNumber(t.count),
              }))}
              onChange={(next) => {
                setGroupType(next);
                setOffset(0);
              }}
              allowClear
            />
          ) : null}
        </div>
        <ColumnsMenu
          propertyKeys={propertyKeys}
          visible={visible}
          onToggle={toggleColumn}
        />
      </div>

      {query.isPending ? (
        <TableSkeleton />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={search || groupType ? "No groups found" : "No groups yet"}
          description={
            search || groupType
              ? "No groups match your filters."
              : "Groups appear here as events and memberships arrive carrying a group association (account, team, company, …)."
          }
        />
      ) : (
        <div className="rounded-lg border bg-white/[0.015]">
          <Table>
            <TableHeader>
              <TableRow>
                <SortHead column="name" label="Group" />
                {visible.has("type") ? <TableHead>Type</TableHead> : null}
                {visible.has("members") ? (
                  <SortHead column="members" label="Members" align="right" />
                ) : null}
                {visible.has("revenue") ? (
                  <SortHead
                    column="revenue"
                    label="Revenue"
                    hint={revenueHint}
                    align="right"
                  />
                ) : null}
                {propertyColumns.map((key) => (
                  <TableHead key={key} className="font-mono normal-case">
                    {key}
                  </TableHead>
                ))}
                {visible.has("firstSeen") ? (
                  <TableHead>First seen</TableHead>
                ) : null}
                {visible.has("lastSeen") ? (
                  <SortHead column="lastSeen" label="Last seen" />
                ) : null}
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
                    <span className="block font-mono text-white/70 text-xs">
                      {row.groupKey}
                    </span>
                  </TableCell>
                  {visible.has("type") ? (
                    <TableCell>
                      <code className="rounded border border-hairline-faint bg-white/[0.04] px-1.5 py-0.5 font-mono text-white/70 text-xs">
                        {row.groupType}
                      </code>
                    </TableCell>
                  ) : null}
                  {visible.has("members") ? (
                    <TableCell className="text-right">
                      {formatNumber(row.memberCount)}
                    </TableCell>
                  ) : null}
                  {visible.has("revenue") ? (
                    <TableCell className="whitespace-nowrap text-right">
                      <RevenueCell row={row} fx={fx} />
                    </TableCell>
                  ) : null}
                  {propertyColumns.map((key) => (
                    <TableCell key={key} className="text-white/70 text-xs">
                      {renderPropertyValue(row.properties[key])}
                    </TableCell>
                  ))}
                  {visible.has("firstSeen") ? (
                    <TableCell className="text-white/60">
                      {formatDateTime(row.firstSeenAt)}
                    </TableCell>
                  ) : null}
                  {visible.has("lastSeen") ? (
                    <TableCell className="text-white/60">
                      {formatDateTime(row.lastSeenAt)}
                    </TableCell>
                  ) : null}
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
