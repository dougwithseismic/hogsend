import type { JourneySimulation, SimulationStep } from "@hogsend/testing";
import picocolors from "picocolors";

/**
 * Renderers for `hogsend simulate`. Every format is built from one row model
 * so text and markdown always describe the same timeline. The json format is
 * the raw `JourneySimulation` reports from `@hogsend/testing`.
 */

/** A detail fragment: plain text, or an identifier rendered as code. */
type Part = string | { code: string };
type Tone = "plain" | "muted" | "good" | "warn" | "bad";

export interface TimelineRow {
  /** Offset from the run start, e.g. `+2d 6h`. */
  time: string;
  step: string;
  detail: Part[];
  tone: Tone;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact offset from the run start: `+0m`, `+45s`, `+6h`, `+2d 6h 30m`. */
export function formatOffset(ms: number): string {
  if (ms <= 0) return "+0m";
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  const seconds = Math.round((ms % MINUTE) / 1000);
  const parts = [
    days ? `${days}d` : "",
    hours ? `${hours}h` : "",
    minutes ? `${minutes}m` : "",
    seconds && !days && !hours ? `${seconds}s` : "",
  ].filter(Boolean);
  return `+${parts.length ? parts.join(" ") : "0m"}`;
}

/** A wait length without the leading `+`. */
const formatLength = (ms: number): string => formatOffset(ms).slice(1);

const plural = (count: number, unit: string): string =>
  `${count} ${unit}${count === 1 ? "" : "s"}`;

/** Human duration for the summary line: at most the two largest units. */
export function humanDuration(ms: number): string {
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const minutes = Math.round((ms % HOUR) / MINUTE);
  const parts: string[] = [];
  if (days) parts.push(plural(days, "day"));
  if (hours) parts.push(plural(hours, "hour"));
  if (minutes && parts.length < 2) parts.push(plural(minutes, "minute"));
  return parts.slice(0, 2).join(" ") || "under a minute";
}

const CHANNEL_NOUN: Record<
  keyof JourneySimulation["summary"]["sent"],
  [string, string]
> = {
  email: ["email", "emails"],
  sms: ["SMS", "SMS"],
  feed: ["feed item", "feed items"],
  connector: ["connector action", "connector actions"],
};

const STEP_CHANNEL: Record<keyof JourneySimulation["summary"]["sent"], string> =
  {
    email: "Email",
    sms: "SMS",
    feed: "Feed item",
    connector: "Connector",
  };

const renderSummaryParts = (report: JourneySimulation): Part[] => {
  if (report.status === "skipped") {
    return [
      "Not enrolled: ",
      { code: report.entry.reason ?? "skipped" },
      " (enrollment guard).",
    ];
  }
  const sent = Object.entries(report.summary.sent)
    .filter(([, count]) => count > 0)
    .map(([channel, count]) => {
      const [one, many] =
        CHANNEL_NOUN[channel as keyof typeof CHANNEL_NOUN] ?? [];
      return `${count} ${count === 1 ? one : many}`;
    });
  const messages = sent.length ? sent.join(", ") : "No messages";
  const blocked = report.summary.blocked
    ? ` (${report.summary.blocked} blocked)`
    : "";
  const span =
    report.virtualDurationMs > 0
      ? ` over ${humanDuration(report.virtualDurationMs)}`
      : "";
  const parts: Part[] = [`${messages}${blocked}${span}; `];
  if (report.status === "completed") parts.push("completes.");
  else if (report.status === "exited") {
    if (report.exit?.source === "exitOn" && report.exit.reason) {
      parts.push("exits on ", { code: report.exit.reason }, ".");
    } else if (report.exit?.reason) {
      parts.push(`exits early: ${report.exit.reason}.`);
    } else parts.push("exits early.");
  } else parts.push(`fails: ${report.error?.message ?? "unknown error"}`);
  return parts;
};

const compactJson = (value: Record<string, unknown>): string | undefined => {
  if (Object.keys(value).length === 0) return undefined;
  const json = JSON.stringify(value);
  return json.length > 80 ? `${json.slice(0, 77)}...` : json;
};

function waitRow(
  step: Extract<SimulationStep, { kind: "wait" }>,
  offset: (at: string) => string,
): Omit<TimelineRow, "time"> {
  const detail: Part[] = [{ code: step.label }];
  const length =
    step.durationMs !== undefined ? formatLength(step.durationMs) : undefined;
  let name = "Sleep";
  if (step.wait === "sleep") {
    if (length) detail.push(` for ${length}`);
  } else if (step.wait === "sleepUntil") {
    name = "Sleep until";
    if (length) detail.push(` for ${length}`);
  } else if (step.wait === "waitForEvent") {
    name = "Wait for event";
    detail.push(": ", { code: step.event ?? "?" });
    if (length) detail.push(` up to ${length}`);
  } else {
    name = "Digest";
    if (step.event) detail.push(": collect ", { code: step.event });
    if (length) detail.push(` for ${length}`);
  }
  const at = offset(step.resumedAt);
  let tone: Tone = "muted";
  if (step.outcome === "matched") {
    detail.push(
      step.source === "lookback"
        ? " → already happened (lookback)"
        : ` → event arrived at ${at}`,
    );
    tone = "plain";
  } else if (step.outcome === "timedOut") {
    detail.push(` → timed out at ${at}`);
  } else if (step.outcome === "exited") {
    detail.push(` → interrupted by exit at ${at}`);
    tone = "warn";
  } else {
    detail.push(
      step.wait === "digest" ? ` → flushed at ${at}` : ` → resumed at ${at}`,
    );
  }
  return { step: name, detail, tone };
}

function stepRow(
  step: SimulationStep,
  report: JourneySimulation,
  offset: (at: string) => string,
): Omit<TimelineRow, "time"> {
  const otherUser = (userId: string): Part[] =>
    userId && userId !== report.user.id
      ? [" (user ", { code: userId }, ")"]
      : [];
  switch (step.kind) {
    case "enrolled":
      return {
        step: "Enrolled",
        detail: ["on ", { code: step.event }],
        tone: "good",
      };
    case "skipped":
      return {
        step: "Skipped",
        detail: ["enrollment guard: ", { code: step.reason }],
        tone: "warn",
      };
    case "event": {
      const props = compactJson(step.properties);
      return {
        step: "Event",
        detail: [
          { code: step.event },
          ...otherUser(step.userId),
          ...(props ? [" ", { code: props }] : []),
        ],
        tone: "plain",
      };
    }
    case "wait":
      return waitRow(step, offset);
    case "checkpoint":
      return {
        step: "Checkpoint",
        detail: [{ code: step.label }],
        tone: "muted",
      };
    case "variant":
      return {
        step: "Variant",
        detail: [{ code: step.key }, " → ", { code: step.arm }],
        tone: "plain",
      };
    case "send": {
      const detail: Part[] = [{ code: step.template }];
      if (step.to) detail.push(` → ${step.to}`);
      if (step.subject) detail.push(` · "${step.subject}"`);
      if (step.idempotencyLabel) {
        detail.push(" · label ", { code: step.idempotencyLabel });
      }
      const blocked = step.status !== "sent";
      if (blocked)
        detail.push(" · blocked: ", { code: step.reason ?? step.status });
      return {
        step: `${STEP_CHANNEL[step.channel]}${blocked ? " (blocked)" : ""}`,
        detail,
        tone: blocked ? "warn" : "good",
      };
    }
    case "trigger":
      return {
        step: "Trigger",
        detail: [{ code: step.event }, ...otherUser(step.userId)],
        tone: "plain",
      };
    case "guard":
      return step.subscribed
        ? {
            step: "Resubscribed",
            detail: ["global subscription on"],
            tone: "plain",
          }
        : {
            step: "Unsubscribed",
            detail: ["global subscription off"],
            tone: "warn",
          };
    case "exit":
      return {
        step: "Exited",
        detail:
          step.source === "exitOn"
            ? [{ code: step.reason ?? "?" }, " (exitOn)"]
            : [`ctx.exit${step.reason ? `: ${step.reason}` : ""}`],
        tone: "warn",
      };
    case "completed":
      return { step: "Completed", detail: [], tone: "good" };
    case "failed":
      return { step: "Failed", detail: [step.error], tone: "bad" };
  }
}

/** The shared row model behind the text and markdown renderers. */
export function timelineRows(report: JourneySimulation): TimelineRow[] {
  const start = new Date(report.startedAt).getTime();
  const offset = (at: string): string =>
    formatOffset(new Date(at).getTime() - start);
  return report.steps.map((step) => ({
    time: offset(step.at),
    ...stepRow(step, report, offset),
  }));
}

const startLabel = (iso: string): string =>
  `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

const forcedNote = (report: JourneySimulation): Part[] | undefined =>
  report.entry.forced
    ? [
        "Enrollment guard would skip this user (",
        { code: report.entry.reason ?? "?" },
        "); simulated anyway with --force.",
      ]
    : undefined;

const notReachedParts = (report: JourneySimulation): Part[] | undefined => {
  if (report.notReached.length === 0) return undefined;
  const start = new Date(report.startedAt).getTime();
  const parts: Part[] = ["Not reached (the run ended first): "];
  report.notReached.forEach((event, index) => {
    if (index > 0) parts.push(", ");
    parts.push(
      { code: event.event },
      ` at ${formatOffset(new Date(event.at).getTime() - start)}`,
    );
  });
  parts.push(".");
  return parts;
};

/** The one-line summary, e.g. "3 emails over 9 days; exits on `x`." */
export function summaryLine(report: JourneySimulation): string {
  return markdownParts(renderSummaryParts(report));
}

const escapeCell = (text: string): string =>
  text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

const markdownParts = (parts: Part[], cell = false): string =>
  parts
    .map((part) => {
      if (typeof part === "string") return cell ? escapeCell(part) : part;
      const code = part.code.replace(/`/g, "'");
      return `\`${cell ? escapeCell(code) : code}\``;
    })
    .join("");

/** A markdown section per report, suitable for a PR comment. */
export function formatMarkdown(reports: JourneySimulation[]): string {
  return reports
    .map((report) => {
      const lines = [
        `### \`${report.journey.id}\` · ${escapeCell(report.scenario)}`,
        "",
        `**${markdownParts(renderSummaryParts(report))}**`,
        "",
        `User \`${report.user.id}\` (${report.user.email}) · starts ${startLabel(report.startedAt)}`,
      ];
      const forced = forcedNote(report);
      if (forced) lines.push("", `> ${markdownParts(forced)}`);
      lines.push("", "| Time | Step | Detail |", "| --- | --- | --- |");
      for (const row of timelineRows(report)) {
        lines.push(
          `| ${row.time} | ${row.step} | ${markdownParts(row.detail, true)} |`,
        );
      }
      const missed = notReachedParts(report);
      if (missed) lines.push("", `_${markdownParts(missed)}_`);
      return lines.join("\n");
    })
    .join("\n\n");
}

/** Terminal rendering. Colors are opt-in so output stays stable in pipes. */
export function formatText(
  reports: JourneySimulation[],
  opts: { color?: boolean } = {},
): string {
  const c = picocolors.createColors(opts.color ?? false);
  const paint: Record<Tone, (text: string) => string> = {
    plain: (text) => text,
    muted: c.dim,
    good: c.green,
    warn: c.yellow,
    bad: c.red,
  };
  const textParts = (parts: Part[]): string =>
    parts
      .map((part) => (typeof part === "string" ? part : c.cyan(part.code)))
      .join("");
  return reports
    .map((report) => {
      const rows = timelineRows(report);
      const timeWidth = Math.max(4, ...rows.map((row) => row.time.length));
      const stepWidth = Math.max(4, ...rows.map((row) => row.step.length));
      const lines = [
        `${c.bold(report.journey.id)} ${c.dim("·")} ${report.scenario}`,
        textParts(renderSummaryParts(report)),
        c.dim(
          `user ${report.user.id} <${report.user.email}> · starts ${startLabel(report.startedAt)}`,
        ),
      ];
      const forced = forcedNote(report);
      if (forced) lines.push(c.yellow(textParts(forced)));
      lines.push("");
      for (const row of rows) {
        lines.push(
          `  ${c.dim(row.time.padEnd(timeWidth))}  ${paint[row.tone](
            row.step.padEnd(stepWidth),
          )}  ${textParts(row.detail)}`.trimEnd(),
        );
      }
      const missed = notReachedParts(report);
      if (missed) lines.push("", c.dim(textParts(missed)));
      return lines.join("\n");
    })
    .join("\n\n");
}
