import { parseArgs } from "node:util";
import { isHttpError } from "../lib/http.js";
import { color } from "../lib/output.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend campaigns <subcommand> [options]

Queue and inspect broadcasts: durably send one email template to every
subscribed member of a list (or every active member of a bucket). Wraps the
data-plane campaigns routes (POST /v1/campaigns, GET /v1/campaigns/{id}).

Subcommands:
  send                  Queue a campaign. Sends run async in the worker.
  status <id>           Show a campaign's status + send counts.

send options (exactly one of --list / --bucket, plus --template, required):
  --list <id>           Target every subscribed member of this list.
  --bucket <id>         Target every active member of this bucket.
  --template <key>      Email template to send.
  --prop <key=value>    Template prop; repeatable. Value parsed as JSON, falling
                        back to a string.
  --props <json>        Template props as one JSON object (merged with --prop).
  --name <text>         Human label for the campaign.
  --from <addr>         Override the default From address.
  --subject <text>      Override the rendered subject.

Global options (handled by the router): --url, --admin-key, --data-key, --json,
-h/--help.

Examples:
  hogsend campaigns send --list newsletter --template june-update --name "June"
  hogsend campaigns send --bucket power-users --template feature-launch --json
  hogsend campaigns status cmp_123 --json`;

const badge = `${color.bgMagenta(color.black(" hogsend "))} campaigns`;

/** Shape returned by POST /v1/campaigns (202 enqueue ack). */
interface SendResponse {
  campaignId: string;
  status: "queued" | "sending" | "sent" | "failed";
}

/** Shape returned by GET /v1/campaigns/{id}. */
interface StatusResponse {
  id: string;
  name: string;
  status: "queued" | "sending" | "sent" | "failed";
  audienceKind: "list" | "bucket";
  audienceId: string;
  templateKey: string;
  totalRecipients: number;
  sentCount: number;
  skippedCount: number;
  failedCount: number;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
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

function statusColor(status: SendResponse["status"]): string {
  switch (status) {
    case "sent":
      return color.green(status);
    case "queued":
    case "sending":
      return color.cyan(status);
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

  const props = parseProps(ctx, values.props, values.prop);

  const body: {
    template: string;
    list?: string;
    bucket?: string;
    props?: Record<string, unknown>;
    name?: string;
    from?: string;
    subject?: string;
  } = { template };
  if (list) body.list = list;
  if (bucket) body.bucket = bucket;
  if (props) body.props = props;
  if (values.name) body.name = values.name;
  if (values.from) body.from = values.from;
  if (values.subject) body.subject = values.subject;

  let res: SendResponse;
  try {
    res = await ctx.out.step(`Queuing campaign ${template}`, () =>
      ctx.dataHttp.post<SendResponse>("/v1/campaigns", body),
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
    },
    "Campaign queued",
  );
  ctx.out.outro(
    `${color.green("Queued")} — poll ${color.cyan(`hogsend campaigns status ${res.campaignId}`)} for progress.`,
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

async function run(ctx: CommandContext): Promise<void> {
  const sub = ctx.argv[0];

  switch (sub) {
    case "send":
      // Strip the leading "send" token; the rest is send's own args.
      return runSend(ctx, ctx.argv.slice(1));
    case "status":
      return runStatus(ctx, ctx.argv.slice(1));
    case undefined:
      ctx.out.fail(
        "campaigns requires a subcommand: send | status (see hogsend campaigns --help)",
      );
      break;
    default:
      ctx.out.fail(
        `unknown campaigns subcommand "${sub}" — expected send or status`,
      );
  }
}

export const campaignsCommand: Command = {
  name: "campaigns",
  summary: "Queue a broadcast to a list/bucket, or check its status",
  usage,
  run,
};
