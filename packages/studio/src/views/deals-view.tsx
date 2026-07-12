import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { BadgePoundSterling, Clock, HandCoins, TrendingUp } from "lucide-react";
import { useState } from "react";
import { StatCard } from "@/components/stat-card";
import {
  CardsSkeleton,
  EmptyState,
  ErrorState,
  PageHeader,
  TableSkeleton,
} from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { type Deal, getDealsStats, listDeals, qk } from "@/lib/admin-api";
import { formatDateTime, formatNumber } from "@/lib/format";

/**
 * The revenue ledger (plan §4b.2): front-and-center money numbers over the
 * deals projection + a pipeline board grouped by canonical stage.
 */

/** Fallback for engines that predate the configurable ladder. */
const DEFAULT_STAGES = [
  "lead",
  "contacted",
  "survey_booked",
  "quoted",
  "sold",
  "lost",
];

/** Humanize a stage id: "survey_booked" / "poc-review" → "Survey booked". */
function stageLabel(stage: string): string {
  const words = stage.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function money(amount: number, currency: string | null): string {
  if (currency) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        maximumFractionDigits: 0,
      }).format(amount);
    } catch {
      // Unknown code — fall through to the plain number.
    }
  }
  return formatNumber(Math.round(amount));
}

function DealCard({ deal }: { deal: Deal }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="truncate text-sm text-white">
          {deal.contactEmail ?? deal.externalId}
        </p>
        {deal.value !== null ? (
          <p className="shrink-0 text-sm font-medium text-white">
            {money(deal.value, deal.currency)}
          </p>
        ) : null}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <Badge variant="outline">{deal.provider}</Badge>
        <p className="text-xs text-white/40">
          {deal.lastStageAt ? formatDateTime(deal.lastStageAt) : "—"}
        </p>
      </div>
    </div>
  );
}

export function DealsView() {
  const [stage, setStage] = useState("");
  const [provider, setProvider] = useState("");
  const [minValue, setMinValue] = useState("");

  const filters = {
    stage: stage || undefined,
    provider: provider || undefined,
    minValue: minValue ? Number(minValue) : undefined,
  };

  const statsQuery = useQuery({
    queryKey: qk.dealsStats,
    queryFn: getDealsStats,
  });
  const dealsQuery = useQuery({
    queryKey: qk.deals(filters),
    queryFn: () => listDeals(filters),
    placeholderData: keepPreviousData,
  });

  const primary = statsQuery.data?.currencies[0];
  const deals = dealsQuery.data?.deals ?? [];
  // Column order = the deployment's configured ladder (served by /stats).
  const stages = statsQuery.data?.stageOrder ?? DEFAULT_STAGES;
  const board = stages.map((s) => ({
    stage: s,
    deals: deals.filter((d) => d.canonicalStage === s),
  }));
  const stageFilterOptions = [
    { value: "", label: "All stages" },
    ...stages.map((s) => ({ value: s, label: stageLabel(s) })),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Deals"
        description="The revenue ledger — every CRM deal, projected onto the canonical funnel."
      />

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

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-44">
          <Select
            value={stage}
            onChange={(e) => setStage(e.target.value)}
            aria-label="Filter by stage"
          >
            {stageFilterOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        <Input
          className="w-44"
          placeholder="Provider (e.g. ghl)"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
        />
        <Input
          className="w-44"
          placeholder="Min value"
          inputMode="numeric"
          value={minValue}
          onChange={(e) => setMinValue(e.target.value.replace(/[^0-9.]/g, ""))}
        />
      </div>

      {dealsQuery.isPending ? (
        <TableSkeleton rows={6} />
      ) : dealsQuery.isError ? (
        <ErrorState
          error={dealsQuery.error}
          onRetry={() => dealsQuery.refetch()}
        />
      ) : deals.length === 0 ? (
        <EmptyState
          title="No deals match"
          description="Loosen the filters, or wait for the next CRM stage change."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3 xl:grid-cols-6">
          {board.map(({ stage: s, deals: column }) => (
            <div key={s} className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-medium uppercase tracking-wide text-white/50">
                  {stageLabel(s)}
                </h3>
                <span className="text-xs text-white/40">{column.length}</span>
              </div>
              <div className="space-y-2">
                {column.map((deal) => (
                  <DealCard key={deal.id} deal={deal} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
