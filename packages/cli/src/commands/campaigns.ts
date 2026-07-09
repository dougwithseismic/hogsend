import { parseArgs } from "node:util";
import { isHttpError } from "../lib/http.js";
import { color } from "../lib/output.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend campaigns <subcommand> [options]

Queue, schedule, and inspect broadcasts: durably send one email template to
every subscribed member of a list (or every active member of a bucket). Wraps
the data-plane campaigns routes (POST/GET /v1/campaigns,
POST /v1/campaigns/{id}/cancel).

Subcommands:
  send                  Queue (or schedule, with --at) a campaign.
  status <id>           Show a campaign's status + send counts.
  list                  List campaigns, newest first.
  cancel <id>           Cancel a scheduled/queued/sending campaign.

send options (exactly one of --list / --bucket, plus --template, required):
  --list <id>           Target every subscribed member of this list.
  --bucket <id>         Target every active member of this bucket.
  --template <key>      Email template to send.
  --at <iso>            Schedule for a future instant (ISO 8601) instead of
                        sending now, e.g. --at 2026-07-15T16:00:00Z.
  --prop <key=value>    Template prop; repeatable. Value parsed as JSON, falling
                        back to a string.
  --props <json>        Template props as one JSON object (merged with --prop).
  --name <text>         Human label for the campaign.
  --from <addr>         Override the default From address.
  --subject <text>      Override the rendered subject.
  --idempotency-key <k> Retry-safe create: the same key resolves to the same
                        campaign instead of double-blasting the audience.

list options:
  --status <s[,s]>      Filter by status (scheduled,queued,sending,sent,failed,
                        canceled,expired).
  --limit <n>           Page size (default 50, max 200).
  --offset <n>          Page offset.

Global options (handled by the router): --url, --admin-key, --data-key, --json,
-h/--help.

Examples:
  hogsend campaigns send --list newsletter --template june-update --name "June"
  hogsend campaigns send --list newsletter --template launch --at 2026-07-15T16:00:00Z
  hogsend campaigns list --status scheduled
  hogsend campaigns cancel cmp_123
  hogsend campaigns status cmp_123 --json`;

const badge = `${color.bgMagenta(color.black(" hogsend "))} campaigns`;

type CampaignStatus =
  | "scheduled"
  | "queued"
  | "sending"
  | "sent"
  | "failed"
  | "canceled"
  | "expired";

/** Shape returned by POST /v1/campaigns (202 ack). */
interface SendResponse {
  campaignId: string;
  status: CampaignStatus;
  scheduledAt?: string | null;
}

/** Shape returned by GET /v1/campaigns/{id} and the cancel route. */
interface StatusResponse {
  id: string;
  name: string;
  status: CampaignStatus;
  audienceKind: "list" | "bucket";
  audienceId: string;
  templateKey: string;
  totalRecipients: number;
  sentCount: number;
  skippedCount: number;
  failedCount: number;
  scheduledAt: string | null;
  canceledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

/** Shape returned by GET /v1/campaigns (list). */
interface ListResponse {
  campaigns: StatusResponse[];
  hasMore: boolean;
}

/**
 * Parse `--prop key=value` (repeatable) + an optional `--props <json>` object
 * into a single props record. Each `--prop` value is JSON-parsed when valid
 * JSON, else kept as a string. The `--props` object is applied first, so later
 * `--prop` flags win.
 */
function parseProps(
  ctx: CommandContext,
  propsJson: string | undefined,
  propPairs: string[] | undefined,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  let any = false;

  if (propsJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(propsJson);
    } catch {
      ctx.out.fail(`--props must be valid JSON, got: ${propsJson}`);
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      ctx.out.fail("--props must be a JSON object");
    }
    Object.assign(out, parsed as Record<string, unknown>);
    any = true;
  }

  for (const pair of propPairs ?? []) {
    const eq = pair.indexOf("=");
    if (eq === -1) {
      ctx.out.fail(`--prop must be key=value, got: ${pair}`);
    }
    const key = pair.slice(0, eq).trim();
    if (key === "") {
      ctx.out.fail(`--prop key cannot be empty, got: ${pair}`);
    }
    out[key] = coerceValue(pair.slice(eq + 1));
    any = true;
  }

  return any ? out : undefined;
}

/** JSON-parse a flag value, falling back to the raw string. */
function coerceValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function statusColor(status: CampaignStatus): string {
  switch (status) {
    case "sent":
      return color.green(status);
    case "scheduled":
    case "queued":
    case "sending":
      return color.cyan(status);
    case "canceled":
    case "expired":
      return color.yellow(status);
    default:
      // failed
      return color.red(status);
  }
}

async function runSend(ctx: CommandContext, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      list: { type: "string" },
      bucket: { type: "string" },
      template: { type: "string" },
      prop: { type: "string", multiple: true },
      props: { type: "string" },
      name: { type: "string" },
      from: { type: "string" },
      subject: { type: "string" },
      at: { type: "string" },
      "idempotency-key": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  const list = values.list;
  const bucket = values.bucket;
  if ((list && bucket) || (!list && !bucket)) {
    ctx.out.fail("campaigns send requires exactly one of --list or --bucket");
  }

  const template = values.template;
  if (!template) {
    ctx.out.fail(
      "campaigns send requires --template, e.g. hogsend campaigns send --list newsletter --template welcome",
    );
  }

  // Validate --at locally so a typo fails fast with a clear message instead of
  // a server 400. Sent as the parsed instant's ISO form.
  let sendAt: string | undefined;
  if (values.at) {
    const at = new Date(values.at);
    if (Number.isNaN(at.getTime())) {
      ctx.out.fail(`--at must be an ISO 8601 instant, got: ${values.at}`);
    }
    sendAt = at.toISOString();
  }

  const props = parseProps(ctx, values.props, values.prop);

  const body: {
    template: string;
    list?: string;
    bucket?: string;
    props?: Record<string, unknown>;
    name?: string;
    from?: string;
    subject?: string;
    sendAt?: string;
    idempotencyKey?: string;
  } = { template };
  if (list) body.list = list;
  if (bucket) body.bucket = bucket;
  if (props) body.props = props;
  if (values.name) body.name = values.name;
  if (values.from) body.from = values.from;
  if (values.subject) body.subject = values.subject;
  if (sendAt) body.sendAt = sendAt;
  if (values["idempotency-key"]) {
    body.idempotencyKey = values["idempotency-key"];
  }

  let res: SendResponse;
  try {
    res = await ctx.out.step(
      sendAt
        ? `Scheduling campaign ${template} for ${sendAt}`
        : `Queuing campaign ${template}`,
      () => ctx.dataHttp.post<SendResponse>("/v1/campaigns", body),
    );
  } catch (error) {
    if (isHttpError(error)) {
      ctx.out.fail(error.message);
    }
    throw error;
  }

  if (ctx.json) {
    ctx.out.json(res);
    return;
  }

  ctx.out.intro(`${badge} send`);
  ctx.out.kv(
    {
      campaignId: res.campaignId,
      template,
      audience: list ? `list:${list}` : `bucket:${bucket}`,
      status: statusColor(res.status),
      ...(res.scheduledAt ? { scheduledAt: res.scheduledAt } : {}),
    },
    res.status === "scheduled" ? "Campaign scheduled" : "Campaign queued",
  );
  ctx.out.outro(
    res.status === "scheduled"
      ? `${color.green("Scheduled")} — cancel with ${color.cyan(`hogsend campaigns cancel ${res.campaignId}`)} until it fires.`
      : `${color.green("Queued")} — poll ${color.cyan(`hogsend campaigns status ${res.campaignId}`)} for progress.`,
  );
}

async function runStatus(ctx: CommandContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  const id = positionals[0];
  if (!id) {
    ctx.out.fail(
      "campaigns status requires a campaign id, e.g. hogsend campaigns status cmp_123",
    );
  }

  let res: StatusResponse;
  try {
    res = await ctx.out.step(`Fetching campaign ${id}`, () =>
      ctx.dataHttp.get<StatusResponse>(
        `/v1/campaigns/${encodeURIComponent(id)}`,
      ),
    );
  } catch (error) {
    if (isHttpError(error)) {
      ctx.out.fail(error.message);
    }
    throw error;
  }

  if (ctx.json) {
    ctx.out.json(res);
    return;
  }

  ctx.out.intro(`${badge} status`);
  ctx.out.kv(
    {
      id: res.id,
      name: res.name,
      status: statusColor(res.status),
      audience: `${res.audienceKind}:${res.audienceId}`,
      template: res.templateKey,
      recipients: res.totalRecipients,
      sent: color.green(String(res.sentCount)),
      skipped: color.yellow(String(res.skippedCount)),
      failed:
        res.failedCount > 0
          ? color.red(String(res.failedCount))
          : String(res.failedCount),
      startedAt: res.startedAt ?? "",
      completedAt: res.completedAt ?? "",
    },
    "Campaign",
  );
  ctx.out.outro(
    `${res.name} → ${statusColor(res.status)} ` +
      color.dim(
        `(${res.sentCount}/${res.totalRecipients} sent, ${res.skippedCount} skipped, ${res.failedCount} failed)`,
      ),
  );
}

async function runList(ctx: CommandContext, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      status: { type: "string" },
      limit: { type: "string" },
      offset: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  const query = new URLSearchParams();
  if (values.status) query.set("status", values.status);
  if (values.limit) query.set("limit", values.limit);
  if (values.offset) query.set("offset", values.offset);
  const qs = query.size > 0 ? `?${query.toString()}` : "";

  let res: ListResponse;
  try {
    res = await ctx.out.step("Fetching campaigns", () =>
      ctx.dataHttp.get<ListResponse>(`/v1/campaigns${qs}`),
    );
  } catch (error) {
    if (isHttpError(error)) {
      ctx.out.fail(error.message);
    }
    throw error;
  }

  if (ctx.json) {
    ctx.out.json(res);
    return;
  }

  ctx.out.intro(`${badge} list`);
  if (res.campaigns.length === 0) {
    ctx.out.outro("No campaigns found.");
    return;
  }
  for (const campaign of res.campaigns) {
    ctx.out.kv(
      {
        id: campaign.id,
        status: statusColor(campaign.status),
        audience: `${campaign.audienceKind}:${campaign.audienceId}`,
        template: campaign.templateKey,
        ...(campaign.scheduledAt ? { scheduledAt: campaign.scheduledAt } : {}),
        sent: `${campaign.sentCount}/${campaign.totalRecipients}`,
      },
      campaign.name,
    );
  }
  ctx.out.outro(
    res.hasMore
      ? `More available — page with ${color.cyan("--offset")}.`
      : `${res.campaigns.length} campaign(s).`,
  );
}

async function runCancel(ctx: CommandContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  const id = positionals[0];
  if (!id) {
    ctx.out.fail(
      "campaigns cancel requires a campaign id, e.g. hogsend campaigns cancel cmp_123",
    );
  }

  let res: StatusResponse;
  try {
    res = await ctx.out.step(`Canceling campaign ${id}`, () =>
      ctx.dataHttp.post<StatusResponse>(
        `/v1/campaigns/${encodeURIComponent(id)}/cancel`,
        {},
      ),
    );
  } catch (error) {
    if (isHttpError(error)) {
      ctx.out.fail(error.message);
    }
    throw error;
  }

  if (ctx.json) {
    ctx.out.json(res);
    return;
  }

  ctx.out.intro(`${badge} cancel`);
  ctx.out.kv(
    {
      id: res.id,
      name: res.name,
      status: statusColor(res.status),
      canceledAt: res.canceledAt ?? "",
      sent: `${res.sentCount}/${res.totalRecipients}`,
    },
    "Campaign canceled",
  );
  ctx.out.outro(
    `${color.yellow("Canceled")} — recipients not yet dispatched are spared; already-sent emails are not recalled.`,
  );
}

async function run(ctx: CommandContext): Promise<void> {
  const sub = ctx.argv[0];

  switch (sub) {
    case "send":
      // Strip the leading "send" token; the rest is send's own args.
      return runSend(ctx, ctx.argv.slice(1));
    case "status":
      return runStatus(ctx, ctx.argv.slice(1));
    case "list":
      return runList(ctx, ctx.argv.slice(1));
    case "cancel":
      return runCancel(ctx, ctx.argv.slice(1));
    case undefined:
      ctx.out.fail(
        "campaigns requires a subcommand: send | status | list | cancel (see hogsend campaigns --help)",
      );
      break;
    default:
      ctx.out.fail(
        `unknown campaigns subcommand "${sub}" — expected send, status, list, or cancel`,
      );
  }
}

export const campaignsCommand: Command = {
  name: "campaigns",
  summary:
    "Queue or schedule a broadcast to a list/bucket, list campaigns, cancel one",
  usage,
  run,
};
