import { useQuery } from "@tanstack/react-query";
import { Filter } from "lucide-react";
import { FunnelNotes, FunnelStages } from "@/components/funnel";
import { EmptyState, ErrorState } from "@/components/states";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type Campaign,
  type CampaignStep,
  type CampaignStepStats,
  getCampaignStats,
  qk,
} from "@/lib/admin-api";
import {
  formatDateTime,
  formatDurationObject,
  formatNumber,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { formatStepCondition, isMultiStep } from "./campaign-steps";

/** Same terminal accents as the journey funnel / flow rails. */
const NOTE_COLORS = {
  skipped: "#6e7681",
  failed: "#da3633",
  bounced: "#da3633",
  complained: "#da3633",
} as const;

/** Rail hues lifted from the lifecycle band / flow view's NODE_STYLE. */
const STEP_RAIL = {
  send: "#d29922",
  wait: "#6e7681",
} as const;

/** durationMs from stats when present, else the authored duration object. */
function waitLabel(
  step: Extract<CampaignStep, { kind: "wait" }>,
  st: CampaignStepStats | undefined,
): string {
  if (st?.durationMs != null && st.durationMs > 0) {
    return formatDurationObject({ seconds: st.durationMs / 1000 }) ?? "—";
  }
  return formatDurationObject(step.duration) ?? "—";
}

function StepMetric({ label, value }: { label: string; value?: number }) {
  return (
    <span className="whitespace-nowrap">
      <span className="font-medium text-white/80">
        {formatNumber(value ?? 0)}
      </span>{" "}
      {label}
    </span>
  );
}

/**
 * One send step's row — rail dot + step eyebrow + template key + `where`
 * chips, with that wave's engagement numbers right-aligned. Highlighted
 * (accent border + pulse chip) when it is the step the campaign is on.
 */
function SendStepRow({
  index,
  step,
  st,
  current,
  live,
}: {
  index: number;
  step: Extract<CampaignStep, { kind: "send" }>;
  st: CampaignStepStats | undefined;
  current: boolean;
  /** current + actively dispatching ("now") vs current + waiting ("next"). */
  live: boolean;
}) {
  const dropped =
    (st?.bounced ?? 0) + (st?.complained ?? 0) + (st?.failed ?? 0);
  return (
    <li
      className={cn(
        "rounded-md border px-3 py-2",
        current
          ? "border-accent/50 bg-accent/[0.06]"
          : "border-hairline-faint bg-white/[0.015]",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: STEP_RAIL.send }}
        />
        <span className="eyebrow text-[11px] text-white/40">
          step {index + 1}
        </span>
        <code className="font-mono text-xs text-white/90">{step.template}</code>
        {step.where?.map((c) => (
          <code
            key={formatStepCondition(c)}
            className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-white/60"
          >
            {formatStepCondition(c)}
          </code>
        ))}
        {current ? (
          <span className="inline-flex items-center gap-1 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
            <span className="h-1 w-1 animate-pulse rounded-full bg-accent" />
            {live ? "now" : "next"}
          </span>
        ) : null}
        <span className="ml-auto flex items-baseline gap-3 text-xs tabular-nums text-white/50">
          <StepMetric label="sent" value={st?.sends} />
          <StepMetric label="opened" value={st?.opened} />
          <StepMetric label="clicked" value={st?.clicked} />
        </span>
      </div>
      {dropped > 0 || st?.lastSentAt ? (
        <p className="mt-1 flex flex-wrap gap-x-3 pl-3.5 text-[11px] text-white/40 tabular-nums">
          {st?.lastSentAt ? (
            <span>last sent {formatDateTime(st.lastSentAt)}</span>
          ) : null}
          {(st?.bounced ?? 0) > 0 ? (
            <span>{formatNumber(st?.bounced)} bounced</span>
          ) : null}
          {(st?.complained ?? 0) > 0 ? (
            <span>{formatNumber(st?.complained)} complained</span>
          ) : null}
          {(st?.failed ?? 0) > 0 ? (
            <span>{formatNumber(st?.failed)} failed</span>
          ) : null}
        </p>
      ) : null}
    </li>
  );
}

/**
 * The per-step breakdown of a multi-step campaign — one row per authored
 * step, in order: send steps carry their wave's funnel numbers (attributed
 * via the step-scoped send keys), wait steps render as slim separators.
 */
function WaveBreakdown({
  campaign,
  stepStats,
}: {
  campaign: Campaign & { steps: CampaignStep[] };
  stepStats: CampaignStepStats[] | undefined;
}) {
  // While waiting, currentStep already points at the NEXT step to execute.
  const live = campaign.status === "sending";
  const highlight = live || campaign.status === "waiting";
  return (
    <div className="space-y-2 border-t border-hairline-faint pt-3">
      <span className="eyebrow text-xs text-white/35">Waves</span>
      <ol className="space-y-1.5" aria-label="Campaign steps">
        {campaign.steps.map((step, index) => {
          const st = stepStats?.find((s) => s.index === index);
          if (step.kind === "wait") {
            return (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: steps are positional data — the index IS the identity
                key={index}
                className="flex items-center gap-2 px-3 py-0.5 text-[11px] text-white/40"
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: STEP_RAIL.wait }}
                />
                wait {waitLabel(step, st)}
              </li>
            );
          }
          return (
            <SendStepRow
              // biome-ignore lint/suspicious/noArrayIndexKey: steps are positional data — the index IS the identity
              key={index}
              index={index}
              step={step}
              st={st}
              current={highlight && index === campaign.currentStep}
              live={live}
            />
          );
        })}
      </ol>
    </div>
  );
}

/**
 * The campaign's delivery funnel — recipients → sent → delivered → opened →
 * clicked, computed from the campaign row's dispatch counters plus the
 * engagement aggregate over its email sends. Mirrors the journey funnel's
 * stage-card geometry. Multi-step campaigns additionally get a per-step
 * wave breakdown (counters above stay CUMULATIVE across waves).
 */
export function CampaignFunnel({ campaign }: { campaign: Campaign }) {
  const stats = useQuery({
    queryKey: qk.campaignStats(campaign.id),
    queryFn: () => getCampaignStats(campaign.id),
  });

  if (stats.isPending) return <Skeleton className="h-28 w-full" />;
  if (stats.isError) {
    return <ErrorState error={stats.error} onRetry={() => stats.refetch()} />;
  }

  const s = stats.data;

  return (
    <div className="space-y-3">
      {campaign.totalRecipients === 0 && s.sends === 0 ? (
        <EmptyState
          icon={Filter}
          title="No recipients yet"
          description={
            campaign.status === "scheduled"
              ? "The audience is resolved when the scheduled send fires."
              : "Once the blast dispatches, its delivery funnel appears here."
          }
        />
      ) : (
        <>
          <FunnelStages
            ariaLabel="Delivery funnel"
            stages={[
              {
                key: "recipients",
                label: "Recipients",
                value: campaign.totalRecipients,
              },
              { key: "sent", label: "Sent", value: campaign.sentCount },
              { key: "delivered", label: "Delivered", value: s.delivered },
              { key: "opened", label: "Opened", value: s.opened },
              { key: "clicked", label: "Clicked", value: s.clicked },
            ]}
          />
          <FunnelNotes
            label="Didn't land"
            items={[
              {
                key: "skipped",
                label: "Skipped",
                value: campaign.skippedCount,
                color: NOTE_COLORS.skipped,
              },
              {
                key: "failed",
                label: "Failed",
                value: campaign.failedCount,
                color: NOTE_COLORS.failed,
              },
              {
                key: "bounced",
                label: "Bounced",
                value: s.bounced,
                color: NOTE_COLORS.bounced,
              },
              {
                key: "complained",
                label: "Complained",
                value: s.complained,
                color: NOTE_COLORS.complained,
              },
            ]}
          />
        </>
      )}
      {isMultiStep(campaign) ? (
        <WaveBreakdown campaign={campaign} stepStats={s.steps} />
      ) : null}
    </div>
  );
}
