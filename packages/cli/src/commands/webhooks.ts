import { parseArgs } from "node:util";
import { isHttpError } from "../lib/http.js";
import { color } from "../lib/output.js";
import type { Command, CommandContext } from "./types.js";

/**
 * The 21-event outbound catalog, VENDORED from the engine's
 * `WEBHOOK_EVENT_TYPES` (lib/webhook-signing.ts). The CLI cannot import the
 * engine, so the tuple is re-declared here and MUST be kept in sync BY HAND when
 * the engine catalog changes. The `webhook.test` sentinel is NOT a member.
 */
const WEBHOOK_EVENT_TYPES = [
  "contact.created",
  "contact.updated",
  "contact.deleted",
  "contact.unsubscribed",
  "contact.subscribed",
  "contact.control_group",
  "email.sent",
  "email.delivered",
  "email.opened",
  "email.clicked",
  "email.action",
  "email.bounced",
  "email.complained",
  "sms.sent",
  "sms.delivered",
  "sms.failed",
  "sms.clicked",
  "link.clicked",
  "link.arrived",
  "journey.completed",
  "journey.heldout",
  "bucket.entered",
  "bucket.left",
  "crm.stage_changed",
  "crm.deal_quoted",
  "crm.deal_sold",
] as const;

type OutboundEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

const usage = `hogsend webhooks <subcommand> [options]

Manage outbound webhook endpoints — the Svix-style signed event stream Hogsend
emits to your URLs. Wraps the admin routes (/v1/admin/webhooks), so this command
REQUIRES an admin key (--admin-key / HOGSEND_ADMIN_KEY), not the data key.

Subcommands:
  list                       List endpoints.
  get <id>                   Show one endpoint.
  create                     Register an endpoint (prints the secret ONCE).
  update <id>                Patch an endpoint.
  delete <id>                Hard-delete an endpoint (drops its deliveries).
  rotate-secret <id>         Issue a new signing secret (prints it ONCE).
  test <id>                  Enqueue an out-of-band webhook.test delivery.

list options:
  --include-disabled         Include disabled endpoints.
  --limit <n>                Page size.
  --offset <n>               Page offset.

create options (--url required, plus at least one event):
  --url <url>                Destination URL (required).
  --event <type>             Subscribe to an event; repeatable.
  --all-events               Subscribe to all 13 event types.
  --description <text>       Human label.
  --disabled                 Create the endpoint disabled.

update options (only the provided fields change):
  --url <url>                New destination URL.
  --event <type>             Replace the subscribed events (repeatable).
  --all-events               Subscribe to all 13 event types.
  --description <text>       New description.
  --disabled / --enabled     Disable or enable the endpoint.

Event types:
  ${WEBHOOK_EVENT_TYPES.join(", ")}

Global options (handled by the router): --url, --admin-key, --data-key, --json,
-h/--help.

Examples:
  hogsend webhooks create --url https://x.com/hook --event contact.created --event email.sent
  hogsend webhooks create --url https://x.com/hook --all-events --json
  hogsend webhooks list --include-disabled
  hogsend webhooks rotate-secret we_123
  hogsend webhooks test we_123`;

const badge = `${color.bgMagenta(color.black(" hogsend "))} webhooks`;

interface WebhookEndpoint {
  id: string;
  url: string;
  description: string | null;
  eventTypes: OutboundEventType[];
  // null for keyed destinations (kind !== "webhook"), which carry no signing
  // secret — their credentials live in the endpoint config, not a whsec_.
  secretPrefix: string | null;
  status: "enabled" | "disabled";
  organizationId: string | null;
  lastDeliveryAt: string | null;
  createdAt: string;
  updatedAt: string;
}

type CreatedWebhookEndpoint = WebhookEndpoint & { secret: string };

interface ListResponse {
  endpoints: WebhookEndpoint[];
  total: number;
  limit: number;
  offset: number;
}

interface RotateResponse {
  id: string;
  secret: string;
  secretPrefix: string;
}

/** Run an admin HTTP call, mapping HttpError to a clean ctx.out.fail message. */
async function fetchOrFail<T>(
  ctx: CommandContext,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await ctx.out.step(label, fn);
  } catch (err) {
    if (isHttpError(err)) {
      if (err.status === 404) {
        ctx.out.fail(err.message || "webhook endpoint not found");
      }
      ctx.out.fail(err.message);
    }
    throw err;
  }
}

/**
 * Resolve the subscribed event set from `--all-events` and/or repeatable
 * `--event <type>` flags, validating each against the vendored catalog. Returns
 * undefined when neither was passed (so `update` can leave events unchanged).
 */
function resolveEvents(
  ctx: CommandContext,
  allEvents: boolean | undefined,
  events: string[] | undefined,
): OutboundEventType[] | undefined {
  if (allEvents) {
    return [...WEBHOOK_EVENT_TYPES];
  }
  if (!events || events.length === 0) {
    return undefined;
  }
  const valid = new Set<string>(WEBHOOK_EVENT_TYPES);
  const out: OutboundEventType[] = [];
  for (const ev of events) {
    if (!valid.has(ev)) {
      ctx.out.fail(
        `unknown event type "${ev}" — expected one of: ${WEBHOOK_EVENT_TYPES.join(", ")}`,
      );
    }
    if (!out.includes(ev as OutboundEventType)) {
      out.push(ev as OutboundEventType);
    }
  }
  return out;
}

/** Print a created/rotated secret once, with a loud yellow warning. */
function printSecretOnce(ctx: CommandContext, secret: string): void {
  ctx.out.note(
    `${color.yellow("Store this signing secret now — it is shown only once and cannot be recovered.")}\n\n${color.bold(secret)}`,
    color.yellow("Signing secret"),
  );
}

async function runList(ctx: CommandContext, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "include-disabled": { type: "boolean", default: false },
      limit: { type: "string" },
      offset: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  const query = {
    includeDisabled: values["include-disabled"] ? "true" : undefined,
    limit: values.limit,
    offset: values.offset,
  };

  if (!ctx.json) ctx.out.intro(`${badge} list`);

  const res = await fetchOrFail<ListResponse>(ctx, "Fetching webhooks", () =>
    ctx.http.get<ListResponse>("/v1/admin/webhooks", query),
  );

  if (ctx.json) {
    ctx.out.json(res);
    return;
  }

  ctx.out.table(
    res.endpoints.map((ep) => ({
      id: ep.id,
      url: ep.url,
      status:
        ep.status === "enabled"
          ? color.green(ep.status)
          : color.yellow(ep.status),
      events: ep.eventTypes.length,
      lastDeliveryAt: ep.lastDeliveryAt ?? color.dim("(never)"),
    })),
    ["id", "url", "status", "events", "lastDeliveryAt"],
  );
  ctx.out.outro(
    `${res.endpoints.length} of ${res.total} endpoint(s) — offset ${res.offset}, limit ${res.limit}`,
  );
}

function renderEndpoint(
  ctx: CommandContext,
  ep: WebhookEndpoint,
  title: string,
): void {
  ctx.out.kv(
    {
      id: ep.id,
      url: ep.url,
      description: ep.description ?? color.dim("(none)"),
      status:
        ep.status === "enabled"
          ? color.green(ep.status)
          : color.yellow(ep.status),
      eventTypes: ep.eventTypes,
      secretPrefix: ep.secretPrefix ?? color.dim("(none — keyed destination)"),
      lastDeliveryAt: ep.lastDeliveryAt ?? color.dim("(never)"),
      createdAt: ep.createdAt,
      updatedAt: ep.updatedAt,
    },
    title,
  );
}

async function runGet(ctx: CommandContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h", default: false } },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  const id = positionals[0];
  if (!id) {
    ctx.out.fail(
      "webhooks get requires an endpoint id, e.g. hogsend webhooks get we_123",
    );
  }

  if (!ctx.json) ctx.out.intro(`${badge} get`);

  const res = await fetchOrFail<WebhookEndpoint>(ctx, "Fetching webhook", () =>
    ctx.http.get<WebhookEndpoint>(
      `/v1/admin/webhooks/${encodeURIComponent(id)}`,
    ),
  );

  if (ctx.json) {
    ctx.out.json(res);
    return;
  }

  renderEndpoint(ctx, res, "Endpoint");
  ctx.out.outro(`${res.url} → ${res.status}`);
}

async function runCreate(ctx: CommandContext, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      url: { type: "string" },
      event: { type: "string", multiple: true },
      "all-events": { type: "boolean", default: false },
      description: { type: "string" },
      disabled: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  const url = values.url;
  if (!url) {
    ctx.out.fail(
      "webhooks create requires --url, e.g. hogsend webhooks create --url https://x.com/hook --all-events",
    );
  }

  const eventTypes = resolveEvents(ctx, values["all-events"], values.event);
  if (!eventTypes || eventTypes.length === 0) {
    ctx.out.fail(
      "webhooks create requires at least one --event <type> (or --all-events)",
    );
  }

  const body: {
    url: string;
    eventTypes: OutboundEventType[];
    description?: string;
    disabled?: boolean;
  } = { url, eventTypes };
  if (values.description !== undefined) body.description = values.description;
  if (values.disabled) body.disabled = true;

  if (!ctx.json) ctx.out.intro(`${badge} create`);

  const res = await fetchOrFail<CreatedWebhookEndpoint>(
    ctx,
    "Creating webhook",
    () => ctx.http.post<CreatedWebhookEndpoint>("/v1/admin/webhooks", body),
  );

  if (ctx.json) {
    ctx.out.json(res);
    return;
  }

  const { secret, ...endpoint } = res;
  renderEndpoint(ctx, endpoint, "Endpoint created");
  printSecretOnce(ctx, secret);
  ctx.out.outro(`${color.green("Created")} ${res.id} → ${res.url}`);
}

async function runUpdate(ctx: CommandContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      url: { type: "string" },
      event: { type: "string", multiple: true },
      "all-events": { type: "boolean", default: false },
      description: { type: "string" },
      disabled: { type: "boolean", default: false },
      enabled: { type: "boolean", default: false },
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
      "webhooks update requires an endpoint id, e.g. hogsend webhooks update we_123 --enabled",
    );
  }

  if (values.disabled && values.enabled) {
    ctx.out.fail("webhooks update: pass at most one of --disabled / --enabled");
  }

  const eventTypes = resolveEvents(ctx, values["all-events"], values.event);

  const body: {
    url?: string;
    eventTypes?: OutboundEventType[];
    description?: string;
    disabled?: boolean;
  } = {};
  if (values.url !== undefined) body.url = values.url;
  if (eventTypes !== undefined) body.eventTypes = eventTypes;
  if (values.description !== undefined) body.description = values.description;
  if (values.disabled) body.disabled = true;
  if (values.enabled) body.disabled = false;

  if (Object.keys(body).length === 0) {
    ctx.out.fail(
      "webhooks update: nothing to change — pass --url / --event / --description / --disabled / --enabled",
    );
  }

  if (!ctx.json) ctx.out.intro(`${badge} update`);

  const res = await fetchOrFail<WebhookEndpoint>(ctx, "Updating webhook", () =>
    ctx.http.patch<WebhookEndpoint>(
      `/v1/admin/webhooks/${encodeURIComponent(id)}`,
      body,
    ),
  );

  if (ctx.json) {
    ctx.out.json(res);
    return;
  }

  renderEndpoint(ctx, res, "Endpoint updated");
  ctx.out.outro(`${color.green("Updated")} ${res.id} → ${res.status}`);
}

async function runDelete(ctx: CommandContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h", default: false } },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  const id = positionals[0];
  if (!id) {
    ctx.out.fail(
      "webhooks delete requires an endpoint id, e.g. hogsend webhooks delete we_123",
    );
  }

  if (!ctx.json) ctx.out.intro(`${badge} delete`);

  const res = await fetchOrFail<{ deleted: boolean }>(
    ctx,
    "Deleting webhook",
    () =>
      ctx.http.del<{ deleted: boolean }>(
        `/v1/admin/webhooks/${encodeURIComponent(id)}`,
      ),
  );

  if (ctx.json) {
    ctx.out.json(res);
    return;
  }

  ctx.out.outro(`${color.green("Deleted")} ${id}`);
}

async function runRotate(ctx: CommandContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h", default: false } },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  const id = positionals[0];
  if (!id) {
    ctx.out.fail(
      "webhooks rotate-secret requires an endpoint id, e.g. hogsend webhooks rotate-secret we_123",
    );
  }

  if (!ctx.json) ctx.out.intro(`${badge} rotate-secret`);

  const res = await fetchOrFail<RotateResponse>(
    ctx,
    "Rotating signing secret",
    () =>
      ctx.http.post<RotateResponse>(
        `/v1/admin/webhooks/${encodeURIComponent(id)}/rotate-secret`,
        {},
      ),
  );

  if (ctx.json) {
    ctx.out.json(res);
    return;
  }

  ctx.out.kv({ id: res.id, secretPrefix: res.secretPrefix }, "Secret rotated");
  printSecretOnce(ctx, res.secret);
  ctx.out.outro(
    `${color.green("Rotated")} — the old secret is now invalid. Update every subscriber.`,
  );
}

async function runTest(ctx: CommandContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h", default: false } },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  const id = positionals[0];
  if (!id) {
    ctx.out.fail(
      "webhooks test requires an endpoint id, e.g. hogsend webhooks test we_123",
    );
  }

  if (!ctx.json) ctx.out.intro(`${badge} test`);

  const res = await fetchOrFail<{
    enqueued: boolean;
    eventType: "webhook.test";
  }>(ctx, "Enqueuing test delivery", () =>
    ctx.http.post<{ enqueued: boolean; eventType: "webhook.test" }>(
      `/v1/admin/webhooks/${encodeURIComponent(id)}/test`,
      {},
    ),
  );

  if (ctx.json) {
    ctx.out.json(res);
    return;
  }

  ctx.out.outro(
    `${color.green("Enqueued")} a ${color.cyan(res.eventType)} delivery to ${id}.`,
  );
}

async function run(ctx: CommandContext): Promise<void> {
  const sub = ctx.argv[0];

  switch (sub) {
    case "list":
      return runList(ctx, ctx.argv.slice(1));
    case "get":
      return runGet(ctx, ctx.argv.slice(1));
    case "create":
      return runCreate(ctx, ctx.argv.slice(1));
    case "update":
      return runUpdate(ctx, ctx.argv.slice(1));
    case "delete":
      return runDelete(ctx, ctx.argv.slice(1));
    case "rotate-secret":
      return runRotate(ctx, ctx.argv.slice(1));
    case "test":
      return runTest(ctx, ctx.argv.slice(1));
    case undefined:
      ctx.out.fail(
        "webhooks requires a subcommand: list | get | create | update | delete | rotate-secret | test (see hogsend webhooks --help)",
      );
      break;
    default:
      ctx.out.fail(
        `unknown webhooks subcommand "${sub}" — expected one of list | get | create | update | delete | rotate-secret | test`,
      );
  }
}

export const webhooksCommand: Command = {
  name: "webhooks",
  summary: "Manage outbound webhook endpoints (create, rotate, test)",
  usage,
  run,
};
