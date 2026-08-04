import type { JSX } from "react";
import { TagPill } from "@/components/ds/badge";
import { Card } from "@/components/ds/card";
import { Hairline } from "@/components/ds/decor";
import { cn } from "@/lib/cn";
import type { HealthObservationRow } from "@/src/lib/environment-detail";
import { exactTime } from "@/src/lib/relative-time";
import type { StackAlert } from "@/src/pipeline/health-poll";
import { UNHEALTHY_ALERT_STREAK } from "@/src/pipeline/health-poll";
import { TimeAgo } from "./time-ago";

/**
 * The health poll, as the last N sweeps of one stack.
 *
 * A strip of bars rather than a chart: the sweep records a BOOLEAN and a
 * reason, so there is no magnitude to plot and any line would be inventing one.
 * Every bar is full height and reads by COLOUR, so a bad sweep is a red mark in
 * a green run rather than a shorter bar the eye has to measure. Oldest on the
 * left, newest on the right; every bar carries its exact instant and, when
 * unhealthy, the substrate's reason in the tooltip.
 *
 * The big number is a share of the RECORDED sweeps, rounded to whole percent,
 * and is labelled as that. It is not uptime: the poll samples every minute, a
 * sweep is pass/fail, and nothing here knows how long an outage lasted. Whole
 * percent is the most precision the count can carry.
 *
 * The alert is the derived 3-strike state (`getStackAlerts`), stated as what it
 * is: an observation streak. The poll never transitions a stack, so an alerting
 * environment is still `running` and this section says so rather than implying
 * an outage was acted on.
 */
const TONE_TEXT = {
  accent: "text-accent",
  caution: "text-caution",
  good: "text-good",
} as const;

export function HealthStrip({
  health,
  alert,
  status,
  now,
}: {
  /** Newest first, as read. */
  health: HealthObservationRow[];
  alert: StackAlert | null;
  status: string | null;
  now?: Date;
}): JSX.Element {
  // Read newest-first, drawn oldest-first: a strip reads left to right.
  const bars = [...health].reverse();
  const newest = health[0];
  const unhealthy = health.filter((row) => !row.healthy).length;
  const healthyShare =
    health.length > 0
      ? Math.round(((health.length - unhealthy) / health.length) * 100)
      : null;

  // One tone for the whole card: red once the streak is alerting, amber for any
  // bad sweep in the window, green for a clean window.
  const tone = alert ? "accent" : unhealthy > 0 ? "caution" : "good";

  return (
    <Card className="flex flex-col gap-5 p-0">
      <div className="flex items-start justify-between gap-4 px-5 pt-5">
        <div className="flex flex-col gap-1">
          {healthyShare === null ? (
            <span className="font-medium text-3xl text-white/40 tracking-[-0.03em]">
              —
            </span>
          ) : (
            <span
              className={cn(
                "font-medium text-3xl tracking-[-0.03em]",
                TONE_TEXT[tone],
              )}
            >
              {healthyShare}%
            </span>
          )}
          <h2 className="eyebrow text-white/40">
            {health.length > 0
              ? `Healthy across the last ${health.length} ${
                  health.length === 1 ? "sweep" : "sweeps"
                }`
              : "Health"}
          </h2>
        </div>
        {alert ? (
          <TagPill tone="accent">
            unhealthy {alert.streak} sweeps in a row
          </TagPill>
        ) : newest ? (
          <TagPill tone={newest.healthy ? "good" : "caution"}>
            {newest.healthy ? "healthy" : "unhealthy"}
          </TagPill>
        ) : (
          <TagPill tone="neutral">not polled</TagPill>
        )}
      </div>

      {bars.length > 0 ? (
        <div className="flex flex-col gap-2 px-5">
          <div className="flex h-12 items-stretch gap-[3px]">
            {bars.map((row) => (
              <span
                key={row.id}
                title={`${exactTime(row.checkedAt)} — ${
                  row.healthy
                    ? "healthy"
                    : `unhealthy: ${row.detail ?? "no reason recorded"}`
                }`}
                className={cn(
                  "min-w-[3px] flex-1 rounded-[2px]",
                  row.healthy ? "bg-good/60" : "bg-accent",
                )}
              />
            ))}
          </div>
          <div className="flex items-baseline justify-between gap-4 text-white/40 text-xs">
            <span>
              {unhealthy === 0
                ? "no unhealthy sweeps"
                : `${unhealthy} unhealthy`}
            </span>
            <span>
              newest{" "}
              {newest ? <TimeAgo at={newest.checkedAt} now={now} /> : null}
            </span>
          </div>
        </div>
      ) : (
        <p className="px-5 text-sm text-white/60 leading-6">
          {status === "running"
            ? "No sweep has recorded this stack yet. The poll runs every minute over running stacks."
            : "The health poll only sweeps running stacks, so there is nothing recorded for this one."}
        </p>
      )}

      {alert ? (
        <>
          <Hairline />
          <div className="flex flex-col gap-1.5 px-5 pb-5">
            <p className="text-sm text-white leading-6">
              {alert.streak} consecutive unhealthy sweeps since{" "}
              <TimeAgo at={alert.since} now={now} />. The alert raises at{" "}
              {UNHEALTHY_ALERT_STREAK} in a row and clears on the next healthy
              sweep; the stack is left in its current status either way.
            </p>
            {alert.detail ? (
              <p className="font-mono text-white/60 text-xs leading-5">
                {alert.detail}
              </p>
            ) : null}
          </div>
        </>
      ) : (
        <div className="pb-5" />
      )}
    </Card>
  );
}
