import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import type { Campaign, CampaignWaitStep } from "@/lib/admin-api";
import {
  formatDateTime,
  formatDurationObject,
  formatNumber,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { formatCountdown } from "./campaign-steps";

/**
 * The campaign's linear pipeline — created → (scheduled) → sending →
 * (waiting) → terminal — rendered in the SAME node-card language as the
 * journey flow view (colored rail dot + eyebrow kind + title + mono detail),
 * so a campaign page reads like a journey page. A campaign has no branches,
 * so this is a plain strip rather than a React Flow canvas. A multi-step
 * campaign alternates sending ↔ waiting per wave; the strip stays
 * stage-typed (ONE Wait card summarizes all gaps), not one card per wave.
 */

/** Rail hues lifted from the flow view's NODE_STYLE. */
const RAIL = {
  start: "#3fb950",
  wait: "#6e7681",
  send: "#d29922",
  completed: "#3fb950",
  failed: "#da3633",
  ended: "#6e7681",
} as const;

type StageState = "done" | "current" | "pending";

type Stage = {
  key: string;
  kind: string;
  title: string;
  detail: string | null;
  rail: string;
  state: StageState;
  badge?: ReactNode;
};

/** Fraction of recipients already processed (sent, skipped, or failed). */
function processedFraction(c: Campaign): number {
  if (c.totalRecipients <= 0) return 0;
  const processed = c.sentCount + c.skippedCount + c.failedCount;
  return Math.min(1, processed / c.totalRecipients);
}

function terminalStage(c: Campaign): Stage {
  switch (c.status) {
    case "sent":
      return {
        key: "terminal",
        kind: "Completed",
        title: "Sent",
        detail: formatDateTime(c.completedAt),
        rail: RAIL.completed,
        state: "done",
      };
    case "failed":
      return {
        key: "terminal",
        kind: "Failed",
        title: "Failed",
        detail: formatDateTime(c.completedAt),
        rail: RAIL.failed,
        state: "done",
      };
    case "canceled":
      return {
        key: "terminal",
        kind: "Canceled",
        title: "Canceled",
        detail: formatDateTime(c.canceledAt),
        rail: RAIL.ended,
        state: "done",
      };
    case "expired":
      return {
        key: "terminal",
        kind: "Expired",
        title: "Never sent",
        detail: "send-at was already stale",
        rail: RAIL.ended,
        state: "done",
      };
    default:
      // In flight — the terminal card is the dimmed destination.
      return {
        key: "terminal",
        kind: "Completed",
        title: "Sent",
        detail: null,
        rail: RAIL.completed,
        state: "pending",
      };
  }
}

/**
 * The between-waves Wait stage — present only when the campaign HAS waits
 * (or is somehow `waiting` without a blob). Models `waiting` the way the
 * strip models `scheduled`: presence keyed on data, `current` keyed on
 * status. `done` once any wait has elapsed — the campaign reached a terminal
 * after starting, or a wave past the first wait is dispatching.
 */
function waitingStage(c: Campaign): Stage | null {
  const steps = c.steps ?? [];
  const waits = steps.filter((s): s is CampaignWaitStep => s.kind === "wait");
  if (waits.length === 0 && c.status !== "waiting") return null;

  const current = c.status === "waiting";
  const inFlight = c.status === "queued" || c.status === "sending";
  const terminal = ["sent", "failed", "canceled", "expired"].includes(c.status);
  const firstWaitIndex = steps.findIndex((s) => s.kind === "wait");
  const elapsed =
    (terminal && c.startedAt !== null) ||
    (inFlight && firstWaitIndex !== -1 && c.currentStep > firstWaitIndex);

  const firstWait = waits[0];
  return {
    key: "waiting",
    kind: "Wait",
    title: "Between waves",
    detail: current
      ? formatDateTime(c.nextStepAt)
      : firstWait && waits.length === 1
        ? (formatDurationObject(firstWait.duration) ?? null)
        : `${waits.length} waits`,
    rail: RAIL.wait,
    state: current ? "current" : elapsed ? "done" : "pending",
    badge:
      current && c.nextStepAt ? (
        <span className="mt-1.5 inline-block rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
          next wave in {formatCountdown(c.nextStepAt)}
        </span>
      ) : undefined,
  };
}

function stagesFor(c: Campaign): Stage[] {
  const terminal = terminalStage(c);
  const inFlight = c.status === "queued" || c.status === "sending";
  const stages: Stage[] = [
    {
      key: "created",
      kind: "Start",
      title: "Created",
      detail: formatDateTime(c.createdAt),
      rail: RAIL.start,
      state: "done",
    },
  ];

  if (c.scheduledAt) {
    stages.push({
      key: "scheduled",
      kind: "Schedule",
      title: c.status === "scheduled" ? "Waiting to send" : "Scheduled",
      detail: formatDateTime(c.scheduledAt),
      rail: RAIL.wait,
      state: c.status === "scheduled" ? "current" : "done",
    });
  }

  stages.push({
    key: "sending",
    kind: "Send",
    title:
      c.status === "queued"
        ? "Queued"
        : c.status === "sending"
          ? "Sending"
          : "Dispatched",
    detail: c.startedAt ? formatDateTime(c.startedAt) : null,
    rail: RAIL.send,
    // A terminal reached WITHOUT ever starting (canceled while scheduled,
    // expired) leaves the dispatch card dashed — it never happened.
    state: inFlight ? "current" : c.startedAt ? "done" : "pending",
    badge:
      inFlight || c.startedAt ? (
        <SendProgress campaign={c} live={inFlight} />
      ) : undefined,
  });

  const waiting = waitingStage(c);
  if (waiting) stages.push(waiting);

  stages.push(terminal);
  return stages;
}

/** `sent/total` chip + thin progress bar, accent while the blast is live. */
function SendProgress({
  campaign,
  live,
}: {
  campaign: Campaign;
  live: boolean;
}) {
  const fraction = processedFraction(campaign);
  return (
    <div className="mt-1.5 space-y-1.5">
      <span
        className={cn(
          "inline-block rounded px-1.5 py-0.5 text-[10px] font-medium",
          live ? "bg-accent/15 text-accent" : "bg-white/[0.06] text-white/60",
        )}
      >
        {formatNumber(campaign.sentCount)} /{" "}
        {formatNumber(campaign.totalRecipients)} sent
      </span>
      {campaign.totalRecipients > 0 ? (
        <div className="h-1 overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className={cn(
              "h-full rounded-full transition-[width]",
              live ? "bg-accent" : "bg-white/25",
            )}
            style={{ width: `${Math.round(fraction * 100)}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

function StageCard({ stage }: { stage: Stage }) {
  return (
    <div
      className={cn(
        "min-w-[170px] flex-1 rounded-md border px-3 py-2 text-white/90 transition-colors",
        stage.state === "current"
          ? "border-accent/50 bg-accent/[0.06]"
          : stage.state === "pending"
            ? "border-dashed border-white/10 bg-transparent opacity-60"
            : "border-hairline-faint bg-white/[0.015]",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: stage.rail }}
        />
        <span className="eyebrow text-[11px] text-white/40">{stage.kind}</span>
        {stage.state === "current" ? (
          <span className="ml-auto inline-flex items-center gap-1 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
            <span className="h-1 w-1 animate-pulse rounded-full bg-accent" />
            now
          </span>
        ) : null}
      </div>
      <p className="mt-0.5 truncate text-[13px] font-medium leading-snug text-white/90">
        {stage.title}
      </p>
      <p className="truncate font-mono text-[11px] text-white/45">
        {stage.detail ?? "—"}
      </p>
      {stage.badge}
    </div>
  );
}

export function CampaignLifecycle({ campaign }: { campaign: Campaign }) {
  const stages = stagesFor(campaign);
  return (
    <ol
      className="flex flex-wrap items-stretch gap-2"
      aria-label="Campaign lifecycle"
    >
      {stages.map((stage, i) => (
        <li key={stage.key} className="flex min-w-0 flex-1 items-center gap-2">
          <StageCard stage={stage} />
          {i < stages.length - 1 ? (
            <ArrowRight className="h-4 w-4 shrink-0 text-white/25" />
          ) : null}
        </li>
      ))}
    </ol>
  );
}
