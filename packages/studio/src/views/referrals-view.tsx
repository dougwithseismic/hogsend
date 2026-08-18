import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Share2 } from "lucide-react";
import { useState } from "react";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  TableSkeleton,
} from "@/components/states";
import { Button } from "@/components/ui/button";
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
  getReferralReport,
  qk,
  REFERRAL_MODELS,
  type ReferralBeneficiary,
  type ReferralModel,
  type ReferralValue,
} from "@/lib/admin-api";
import { formatAmountWithCode, formatNumber } from "@/lib/format";

const PAGE_SIZE = 25;

/**
 * Observe-only referral leaderboard. Model, depth and window are REQUEST
 * parameters (PRD 05 §5.3), so the pickers here do nothing but re-query: no
 * report is stored, and changing the model backfills nothing.
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

/** Level weights the depth picker implies: level 1 full, each level halved. */
function defaultWeights(depth: number): string {
  const weights: string[] = [];
  for (let level = 0; level < depth; level++) {
    weights.push(String(0.5 ** level));
  }
  return weights.join(",");
}

/** The per-currency money cell. Never adds two currencies together. */
function ValueCell({ value }: { value: ReferralValue[] }) {
  if (value.length === 0) return <span className="text-white/40">—</span>;
  const parts = value.map((v) => formatAmountWithCode(v.value, v.currency));
  const rest = parts.length - 2;
  return (
    <span className="text-white/80" title={parts.join(" · ")}>
      {parts.slice(0, 2).join(" · ")}
      {rest > 0 ? <span className="text-white/40"> +{rest}</span> : null}
    </span>
  );
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

export function ReferralsView() {
  const navigate = useNavigate();
  const [referral, setReferral] = useState("");
  const [model, setModel] = useState<ReferralModel>("first_touch");
  const [window, setWindow] = useState("30d");
  const [depth, setDepth] = useState(1);
  const [offset, setOffset] = useState(0);

  const filters = {
    referral: referral || undefined,
    model,
    window,
    depth,
    weights: defaultWeights(depth),
    limit: PAGE_SIZE,
    offset,
  };

  const query = useQuery({
    queryKey: qk.referralReport(filters),
    queryFn: () => getReferralReport(filters),
    placeholderData: keepPreviousData,
  });

  const rows = query.data?.beneficiaries ?? [];
  const programs = query.data?.referrals ?? [];
  const hasMore = query.data?.nextOffset != null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Referrals"
        description="Referrers ranked by the revenue their tree produced. Model, depth and window are report parameters, so changing them re-queries and stores nothing."
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
              setOffset(0);
            }}
          />
        ) : null}
        <Combobox
          ariaLabel="Attribution model"
          className="w-44"
          placeholder="Model"
          value={model}
          options={REFERRAL_MODELS.map((id) => ({
            value: id,
            label: MODEL_LABELS[id],
          }))}
          onChange={(next) => {
            setModel(next as ReferralModel);
            setOffset(0);
          }}
        />
        <Combobox
          ariaLabel="Bind window"
          className="w-32"
          placeholder="Window"
          value={window}
          options={WINDOWS.map((w) => ({ value: w, label: w }))}
          onChange={(next) => {
            setWindow(next);
            setOffset(0);
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
            setOffset(0);
          }}
        />
        <span className="text-white/40 text-xs">
          weights {defaultWeights(depth)}
        </span>
      </div>

      {query.isPending ? (
        <TableSkeleton />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Share2}
          title="No referrers yet"
          description="A referrer appears here once someone clicks their shared link and identifies."
        />
      ) : (
        <div className="rounded-lg border bg-white/[0.015]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Referrer</TableHead>
                <TableHead className="text-right">Touched</TableHead>
                <TableHead className="text-right">Bound</TableHead>
                <TableHead className="text-right">Qualified</TableHead>
                <TableHead className="text-right">Tree</TableHead>
                <TableHead className="text-right">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
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
                  <TableCell className="text-right font-mono text-white/60 text-xs">
                    {treeCounts(row)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right">
                    <ValueCell value={row.value} />
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
    </div>
  );
}
