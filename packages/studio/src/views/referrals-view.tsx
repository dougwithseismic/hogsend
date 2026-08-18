import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Ban, Link2, Share2, UserCheck, Users, Wallet } from "lucide-react";
import { useMemo, useState } from "react";
import { BarChart } from "@/components/bar-chart";
import { FunnelStages } from "@/components/funnel";
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
import {
  getReferralOverview,
  getReferralReport,
  qk,
  REFERRAL_MODELS,
  type ReferralBeneficiary,
  type ReferralDefinition,
  type ReferralModel,
  type ReferralOverview,
  type ReferralValue,
} from "@/lib/admin-api";
import {
  formatAmountWithCode,
  formatDuration,
  formatNumber,
} from "@/lib/format";

const PAGE_SIZE = 25;

/**
 * Observe-only referral page: what the program IS (its definition, read back
 * from code), what HAPPENED (funnel, sources, rejections, trend, all from the
 * touch ledger) and WHO drove it (the leaderboard). Model, depth, window and
 * weights are REQUEST parameters (PRD 05 §5.3), so every picker re-queries and
 * stores nothing. Period applies to the header numbers AND the leaderboard's
 * conversions, so the tiles and the table describe one span of time.
 *
 * Money is rendered PER CURRENCY and never summed across currencies. The
 * server applies no rate, so neither does this view.
 */

const MODEL_LABELS: Record<ReferralModel, string> = {
  first_touch: "First touch",
  last_touch: "Last touch",
  linear: "Linear",
  time_decay: "Time decay",
  position: "Position",
};

const WINDOWS = ["7d", "30d", "60d", "90d", "365d"];

const PERIODS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "365", label: "Last 365 days" },
  { value: "all", label: "All time" },
];

const SERIES_METRICS = [
  { value: "touched", label: "Touches" },
  { value: "bound", label: "Binds" },
  { value: "qualified", label: "Qualified" },
] as const;

type SeriesMetric = (typeof SERIES_METRICS)[number]["value"];

/** Level weights the depth picker implies: level 1 full, each level halved. */
function defaultWeights(depth: number): string {
  const weights: string[] = [];
  for (let level = 0; level < depth; level++) {
    weights.push(String(0.5 ** level));
  }
  return weights.join(",");
}

/** `"30"` -> the ISO instant 30 days ago; `"all"` -> undefined. */
function periodFrom(period: string): string | undefined {
  if (period === "all") return undefined;
  const days = Number(period);
  const at = new Date();
  at.setUTCHours(0, 0, 0, 0);
  at.setUTCDate(at.getUTCDate() - days);
  return at.toISOString();
}

/** The per-currency money cell. Never adds two currencies together. */
function ValueCell({
  value,
  max = 2,
}: {
  value: ReferralValue[];
  max?: number;
}) {
  if (value.length === 0) return <span className="text-white/40">—</span>;
  const parts = value.map((v) => formatAmountWithCode(v.value, v.currency));
  const rest = parts.length - max;
  return (
    <span className="text-white/80" title={parts.join(" · ")}>
      {parts.slice(0, max).join(" · ")}
      {rest > 0 ? <span className="text-white/40"> +{rest}</span> : null}
    </span>
  );
}

/** Per-currency money as a stat-card string: "1,200 GBP · 300 USD". */
function valueString(value: ReferralValue[]): string {
  if (value.length === 0) return "—";
  return value
    .map((v) => formatAmountWithCode(v.value, v.currency))
    .join(" · ");
}

/** Referees per level, as "12 / 4 / 1" (level 1 first). */
function treeCounts(row: ReferralBeneficiary): string {
  if (row.tree.length === 0) return "—";
  return row.tree
    .slice()
    .sort((a, b) => a.level - b.level)
    .map((l) => formatNumber(l.referees))
    .join(" / ");
}

/** Per-level value for the tooltip: "L1 120 GBP · L2 20 GBP". */
function treeValueTitle(row: ReferralBeneficiary): string {
  return row.tree
    .slice()
    .sort((a, b) => a.level - b.level)
    .map((l) => `L${l.level}: ${valueString(l.value)}`)
    .join("\n");
}

function DefinitionStrip({ definition }: { definition: ReferralDefinition }) {
  const items: { label: string; value: string }[] = [
    {
      label: "Qualifies on",
      value: definition.qualifyEvent
        ? `${definition.qualifyEvent}${
            definition.qualifyHasConditions ? " (with conditions)" : ""
          }`
        : "identify (bind is qualify)",
    },
    {
      label: "Bind window",
      value: formatDuration(definition.bindWindowMs / 1000),
    },
    {
      label: "Destination",
      value: definition.destination ?? "computed per referrer",
    },
    { label: "Campaign", value: definition.campaign ?? "—" },
    {
      label: "Hooks",
      value: definition.hooks.length ? definition.hooks.join(", ") : "none",
    },
  ];
  return (
    <div className="flex flex-wrap gap-x-8 gap-y-2 rounded-lg border bg-white/[0.015] px-4 py-3">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <span className="eyebrow block text-[10px] text-white/40">
            {item.label}
          </span>
          <span
            className="block max-w-[28ch] truncate font-mono text-white/80 text-xs"
            title={item.value}
          >
            {item.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function CountList({
  items,
  empty,
}: {
  items: { key: string; count: number }[];
  empty: string;
}) {
  if (items.length === 0) {
    return <p className="text-sm text-white/40">{empty}</p>;
  }
  const max = Math.max(...items.map((i) => i.count), 1);
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.key} className="space-y-1">
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-mono text-white/70 text-xs">{item.key}</span>
            <span className="tabular-nums text-white/90">
              {formatNumber(item.count)}
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className="h-full rounded-full bg-white/25"
              style={{ width: `${(item.count / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function OverviewSection({
  overview,
  periodLabel,
}: {
  overview: ReferralOverview;
  periodLabel: string;
}) {
  const [metric, setMetric] = useState<SeriesMetric>("touched");
  const series = overview.series.map((p) => ({
    date: p.date,
    value: p[metric],
  }));
  const rate = (num: number, den: number) =>
    den > 0 ? `${Math.round((num / den) * 100)}% of touched` : undefined;

  return (
    <>
      {overview.definition ? (
        <DefinitionStrip definition={overview.definition} />
      ) : (
        <p className="text-sm text-white/40">
          No definition named "{overview.referral}" is registered in code; the
          numbers below come from the ledger alone.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard
          label="Referrers"
          value={formatNumber(overview.referrers)}
          hint={`with a live touch, ${periodLabel.toLowerCase()}`}
          icon={Users}
        />
        <StatCard
          label="Links minted"
          value={formatNumber(overview.links)}
          hint="live shared links, all time"
          icon={Link2}
        />
        <StatCard
          label="Qualified"
          value={formatNumber(overview.funnel.qualified)}
          hint={rate(overview.funnel.qualified, overview.funnel.touched)}
          icon={UserCheck}
        />
        <StatCard
          label="Referee revenue"
          value={valueString(overview.refereeValue)}
          hint="conversions by referred contacts, before any model or weight"
          icon={Wallet}
        />
        <StatCard
          label="Rejected"
          value={formatNumber(overview.rejected.total)}
          hint={
            overview.rejected.byReason
              .slice(0, 3)
              .map((r) => `${r.reason} ${formatNumber(r.count)}`)
              .join(" · ") || "no touch was refused"
          }
          icon={Ban}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div>
              <CardTitle>Funnel</CardTitle>
              <p className="text-xs text-white/40">
                Touched → bound → qualified → converted, {periodLabel}. A touch
                counts on the day it happened; a conversion counts when the
                referee's conversion fell in the period.
              </p>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <FunnelStages
              ariaLabel="Referral funnel"
              stages={[
                {
                  key: "touched",
                  label: "Touched",
                  value: overview.funnel.touched,
                },
                { key: "bound", label: "Bound", value: overview.funnel.bound },
                {
                  key: "qualified",
                  label: "Qualified",
                  value: overview.funnel.qualified,
                },
                {
                  key: "converted",
                  label: "Converted",
                  value: overview.funnel.converted,
                },
              ]}
            />
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="eyebrow text-white/50">
                  Trend, per {overview.granularity}
                </span>
                <Combobox
                  ariaLabel="Trend metric"
                  className="w-32"
                  placeholder="Metric"
                  value={metric}
                  options={SERIES_METRICS.map((m) => ({
                    value: m.value,
                    label: m.label,
                  }))}
                  onChange={(next) => setMetric(next as SeriesMetric)}
                />
              </div>
              <BarChart data={series} height={140} label={metric} />
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Sources</CardTitle>
              <p className="text-xs text-white/40">
                How touches arrived: a link click, a typed slug, the API or an
                import.
              </p>
            </CardHeader>
            <CardContent>
              <CountList
                items={overview.sources.map((s) => ({
                  key: s.source,
                  count: s.count,
                }))}
                empty="No touches in this period."
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Rejections</CardTitle>
              <p className="text-xs text-white/40">
                Touches the engine refused, by reason.
              </p>
            </CardHeader>
            <CardContent>
              <CountList
                items={overview.rejected.byReason.map((r) => ({
                  key: r.reason,
                  count: r.count,
                }))}
                empty="No touch was refused in this period."
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

export function ReferralsView() {
  const navigate = useNavigate();
  const [referral, setReferral] = useState("");
  const [model, setModel] = useState<ReferralModel>("first_touch");
  const [window, setWindow] = useState("30d");
  const [depth, setDepth] = useState(1);
  const [period, setPeriod] = useState("30");
  const [offset, setOffset] = useState(0);

  const from = useMemo(() => periodFrom(period), [period]);
  const periodLabel =
    PERIODS.find((p) => p.value === period)?.label ?? "Last 30 days";

  const filters = {
    referral: referral || undefined,
    model,
    window,
    depth,
    weights: defaultWeights(depth),
    from,
    limit: PAGE_SIZE,
    offset,
  };

  const query = useQuery({
    queryKey: qk.referralReport(filters),
    queryFn: () => getReferralReport(filters),
    placeholderData: keepPreviousData,
  });

  const overviewFilters = { referral: referral || undefined, from };
  const overviewQuery = useQuery({
    queryKey: qk.referralOverview(overviewFilters),
    queryFn: () => getReferralOverview(overviewFilters),
    placeholderData: keepPreviousData,
  });

  const rows = query.data?.beneficiaries ?? [];
  const programs = query.data?.referrals ?? [];
  const hasMore = query.data?.nextOffset != null;

  const reset = () => setOffset(0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Referrals"
        description="Who is bringing in whom, and what it is worth. Model, depth, window and period are report parameters: changing them re-queries and stores nothing."
      />

      <div className="flex flex-wrap items-center gap-3">
        {programs.length > 1 ? (
          <Combobox
            ariaLabel="Referral program"
            className="w-44"
            placeholder="Program"
            value={referral || (query.data?.referral ?? "")}
            options={programs.map((id) => ({ value: id, label: id }))}
            onChange={(next) => {
              setReferral(next);
              reset();
            }}
          />
        ) : null}
        <Combobox
          ariaLabel="Period"
          className="w-40"
          placeholder="Period"
          value={period}
          options={PERIODS}
          onChange={(next) => {
            setPeriod(next);
            reset();
          }}
        />
        <Combobox
          ariaLabel="Attribution model"
          className="w-40"
          placeholder="Model"
          value={model}
          options={REFERRAL_MODELS.map((id) => ({
            value: id,
            label: MODEL_LABELS[id],
          }))}
          onChange={(next) => {
            setModel(next as ReferralModel);
            reset();
          }}
        />
        <Combobox
          ariaLabel="Bind window"
          className="w-32"
          placeholder="Window"
          value={window}
          options={WINDOWS.map((w) => ({ value: w, label: `bind ≤ ${w}` }))}
          onChange={(next) => {
            setWindow(next);
            reset();
          }}
        />
        <Combobox
          ariaLabel="Tree depth"
          className="w-36"
          placeholder="Depth"
          value={String(depth)}
          options={[1, 2, 3, 4, 5].map((d) => ({
            value: String(d),
            label: `${d} level${d === 1 ? "" : "s"}`,
          }))}
          onChange={(next) => {
            setDepth(Number(next) || 1);
            reset();
          }}
        />
        <span className="font-mono text-white/40 text-xs">
          weights {defaultWeights(depth)}
        </span>
      </div>

      {overviewQuery.isError ? (
        <ErrorState
          error={overviewQuery.error}
          onRetry={() => overviewQuery.refetch()}
        />
      ) : overviewQuery.data ? (
        <OverviewSection
          overview={overviewQuery.data}
          periodLabel={periodLabel}
        />
      ) : (
        <TableSkeleton />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Leaderboard</CardTitle>
          <p className="text-xs text-white/40">
            Referrers ranked by the value their tree produced under{" "}
            {MODEL_LABELS[model].toLowerCase()}, {depth} level
            {depth === 1 ? "" : "s"} deep, {periodLabel.toLowerCase()}. Touched
            / bound / qualified are the referrer's direct counts and ignore the
            model.
          </p>
        </CardHeader>
        <CardContent>
          {query.isPending ? (
            <TableSkeleton />
          ) : query.isError ? (
            <ErrorState error={query.error} onRetry={() => query.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Share2}
              title="No referrers yet"
              description="A referrer appears here once someone lands from their shared link and identifies inside the bind window. Mint links with getReferralLink() on the server or hogsend.referral.link() in the browser."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10 text-right">#</TableHead>
                  <TableHead>Referrer</TableHead>
                  <TableHead className="text-right">Touched</TableHead>
                  <TableHead className="text-right">Bound</TableHead>
                  <TableHead className="text-right">Qualified</TableHead>
                  <TableHead className="text-right">
                    Tree{depth > 1 ? " (L1 / L2 …)" : ""}
                  </TableHead>
                  <TableHead className="text-right">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row, i) => (
                  <TableRow
                    key={row.contactId}
                    className="cursor-pointer"
                    onClick={() =>
                      navigate({
                        to: "/referrals/$contactId",
                        params: { contactId: row.contactId },
                      })
                    }
                  >
                    <TableCell className="text-right tabular-nums text-white/40">
                      {offset + i + 1}
                    </TableCell>
                    <TableCell>
                      <span className="font-medium text-white">
                        {row.contact?.email ||
                          row.contact?.externalId ||
                          row.contactId}
                      </span>
                      <span className="block font-mono text-white/50 text-xs">
                        {row.contactId}
                      </span>
                    </TableCell>
                    <TableCell className="text-right text-white/70">
                      {formatNumber(row.direct.touched)}
                    </TableCell>
                    <TableCell className="text-right text-white/70">
                      {formatNumber(row.direct.bound)}
                    </TableCell>
                    <TableCell className="text-right text-white/70">
                      {formatNumber(row.direct.qualified)}
                    </TableCell>
                    <TableCell
                      className="text-right font-mono text-white/60 text-xs"
                      title={treeValueTitle(row)}
                    >
                      {treeCounts(row)}
                    </TableCell>
                    <TableCell
                      className="whitespace-nowrap text-right"
                      title={treeValueTitle(row)}
                    >
                      <ValueCell value={row.value} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {rows.length > 0 && (offset > 0 || hasMore) ? (
            <div className="mt-4 flex items-center justify-between text-sm text-white/60">
              <span>
                {offset + 1}–{offset + rows.length}
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
        </CardContent>
      </Card>
    </div>
  );
}
