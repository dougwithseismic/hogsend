import { parseArgs } from "node:util";
import { color } from "../lib/output.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend stats [--json]

Show system-wide overview metrics from a running Hogsend instance.
Wraps GET /v1/admin/metrics/overview.

Fields:
  totalContacts     Live (non-deleted) contacts.
  activeJourneys    Journey states currently active or waiting.
  emailsSent24h     Emails sent in the last 24 hours.
  emailsSent7d      Emails sent in the last 7 days.
  emailsSent30d     Emails sent in the last 30 days.
  bounceRate30d     Bounced / sent over the last 30 days (0..1).
  unsubscribeRate   Unsubscribed / total preferences (0..1).

Options:
  --url <baseUrl>      API base URL (default HOGSEND_API_URL or http://localhost:3002).
  --admin-key <key>    Admin bearer key (default HOGSEND_ADMIN_KEY / ADMIN_API_KEY).
  --json               Emit machine-readable JSON only.
  -h, --help           Show this help.`;

/** Shape returned by GET /v1/admin/metrics/overview. */
interface OverviewMetrics {
  totalContacts: number;
  activeJourneys: number;
  emailsSent24h: number;
  emailsSent7d: number;
  emailsSent30d: number;
  bounceRate30d: number;
  unsubscribeRate: number;
}

/** Render a 0..1 rate as a percentage with two decimals, e.g. 0.0123 -> "1.23%". */
function pct(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

async function run(ctx: CommandContext): Promise<void> {
  const { values } = parseArgs({
    args: ctx.argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  const metrics = await ctx.out.step("Fetching overview metrics", () =>
    ctx.http.get<OverviewMetrics>("/v1/admin/metrics/overview"),
  );

  if (ctx.json) {
    ctx.out.json(metrics);
    return;
  }

  ctx.out.intro(`${color.bgMagenta(color.black(" hogsend "))} stats`);

  ctx.out.kv(
    {
      "Total contacts": metrics.totalContacts,
      "Active journeys": metrics.activeJourneys,
      "Emails sent (24h)": metrics.emailsSent24h,
      "Emails sent (7d)": metrics.emailsSent7d,
      "Emails sent (30d)": metrics.emailsSent30d,
      "Bounce rate (30d)": pct(metrics.bounceRate30d),
      "Unsubscribe rate": pct(metrics.unsubscribeRate),
    },
    "Overview",
  );

  ctx.out.outro(color.dim(ctx.http.cfg.baseUrl));
}

export const statsCommand: Command = {
  name: "stats",
  summary: "Show system-wide overview metrics",
  usage,
  run,
};
