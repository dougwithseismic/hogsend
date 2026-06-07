import { parseArgs } from "node:util";
import { isHttpError } from "../lib/http.js";
import { color } from "../lib/output.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend emails <subcommand> [options]

Send a transactional email through the data plane (POST /v1/emails). The send
runs through the full preferences + tracking pipeline (link-click + open).

Subcommands:
  send <template>       Send the named template to a recipient.

send options (at least one of --to / --user-id required):
  --to <addr>           Recipient email address.
  --user-id <id>        External (distinct) id; the recipient email is resolved
                        from the contact (404 if it has no resolvable email).
  --prop <key=value>    Template prop; repeatable. Value parsed as JSON, falling
                        back to a string.
  --props <json>        Template props as one JSON object (merged with --prop).
  --from <addr>         Override the default From address.
  --subject <text>      Override the rendered subject.
  --reply-to <addr>     Set the Reply-To address.
  --category <key>      Preference category / list id to gate the send on.
  --skip-preference-check  Bypass unsubscribe/suppression (requires full-admin).
  --idempotency-key <k> Dedup key.

Global options (handled by the router): --url, --admin-key, --data-key, --json,
-h/--help.

Examples:
  hogsend emails send welcome --to a@b.com --prop name=Ada
  hogsend emails send welcome --user-id user_123 --props '{"name":"Ada"}' --json`;

/** Shape returned by POST /v1/emails. */
interface SendResponse {
  emailSendId: string;
  status: "queued" | "sent" | "suppressed" | "unsubscribed" | "skipped";
  reason?: string;
}

const badge = `${color.bgMagenta(color.black(" hogsend "))} emails`;

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
    case "queued":
    case "sent":
      return color.green(status);
    case "skipped":
      return color.dim(status);
    default:
      // suppressed | unsubscribed
      return color.yellow(status);
  }
}

async function runSend(ctx: CommandContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      to: { type: "string" },
      "user-id": { type: "string" },
      prop: { type: "string", multiple: true },
      props: { type: "string" },
      from: { type: "string" },
      subject: { type: "string" },
      "reply-to": { type: "string" },
      category: { type: "string" },
      "skip-preference-check": { type: "boolean", default: false },
      "idempotency-key": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  // positionals[0] is the template name (the "send" token was already stripped).
  const template = positionals[0];
  if (!template) {
    ctx.out.fail(
      "emails send requires a template, e.g. hogsend emails send welcome --to a@b.com",
    );
  }

  const to = values.to;
  const userId = values["user-id"];
  if (!to && !userId) {
    ctx.out.fail("emails send requires at least one of --to or --user-id");
  }

  const props = parseProps(ctx, values.props, values.prop);

  const body: {
    template: string;
    to?: string;
    userId?: string;
    props?: Record<string, unknown>;
    from?: string;
    subject?: string;
    replyTo?: string;
    category?: string;
    skipPreferenceCheck?: boolean;
    idempotencyKey?: string;
  } = { template };
  if (to) body.to = to;
  if (userId) body.userId = userId;
  if (props) body.props = props;
  if (values.from) body.from = values.from;
  if (values.subject) body.subject = values.subject;
  if (values["reply-to"]) body.replyTo = values["reply-to"];
  if (values.category) body.category = values.category;
  if (values["skip-preference-check"]) body.skipPreferenceCheck = true;
  if (values["idempotency-key"]) {
    body.idempotencyKey = values["idempotency-key"];
  }

  let res: SendResponse;
  try {
    res = await ctx.out.step(`Sending ${template}`, () =>
      ctx.dataHttp.post<SendResponse>("/v1/emails", body),
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
      emailSendId: res.emailSendId,
      template,
      recipient: to ?? userId ?? "",
      status: statusColor(res.status),
      reason: res.reason ?? "",
    },
    "Email send",
  );
  ctx.out.outro(`${template} → ${statusColor(res.status)}.`);
}

async function run(ctx: CommandContext): Promise<void> {
  const sub = ctx.argv[0];

  switch (sub) {
    case "send":
      // Strip the leading "send" token; the rest is send's own args.
      return runSend(ctx, ctx.argv.slice(1));
    case undefined:
      ctx.out.fail(
        "emails requires a subcommand: send (see hogsend emails --help)",
      );
      break;
    default:
      ctx.out.fail(`unknown emails subcommand "${sub}" — expected send`);
  }
}

export const emailsCommand: Command = {
  name: "emails",
  summary: "Send a transactional email through the data plane",
  usage,
  run,
};
