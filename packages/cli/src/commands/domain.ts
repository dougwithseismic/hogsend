import { parseArgs } from "node:util";
import { confirm } from "@clack/prompts";
import type { DnsRecord, EngineDomainStatus } from "@hogsend/engine";
import { detectDnsHost, formatRecordsFor } from "../lib/dns.js";
import { applyRecords, canAutoApply } from "../lib/dns-apply.js";
import { isHttpError, type Query } from "../lib/http.js";
import { color } from "../lib/output.js";
import { bail } from "../lib/prompt.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend domain <subcommand> [options]

Manage the sending domain through the RUNNING instance's admin routes
(/v1/admin/domain) — provider API keys never touch the CLI. Requires an admin
key (--admin-key / HOGSEND_ADMIN_KEY).

Subcommands:
  add <domain>          Register the domain with the email provider, then print
                        the DNS records formatted for YOUR DNS host (detected
                        via NS lookup) with a panel deep link. When a
                        CLOUDFLARE_API_TOKEN / VERCEL_TOKEN is set, offers to
                        apply the records automatically.
  check [<domain>]      Trigger a provider verification pass, then poll status
                        every 15s until verified (exit 0) or timeout (exit 1).
  status                Show domain, provider, verification state, DNS records,
                        and the test-mode banner.

add options:
  --apply               Apply records via the DNS host API without prompting.
  --no-apply            Never apply records (skip the prompt).

check options:
  --timeout <s>         Give up after this many seconds (default 300).
  --once                Poll exactly once; exit per the current state.

status options:
  --refresh             Bypass the server-side cache (forces a provider call).

Global options (handled by the router): --url, --admin-key, --json, -h/--help.

Examples:
  hogsend domain add mysite.com
  hogsend domain add mysite.com --apply
  hogsend domain check --timeout 600
  hogsend domain status --json`;

const badge = `${color.bgMagenta(color.black(" hogsend "))} domain`;

/** Pinned domain validation regex (PROJECT_SPEC §e) — mirrors the admin route. */
const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

/** Poll cadence for `domain check`. */
const POLL_INTERVAL_MS = 15_000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function getStatus(
  ctx: CommandContext,
  opts: { refresh?: boolean } = {},
): Promise<EngineDomainStatus> {
  const query: Query | undefined = opts.refresh
    ? { refresh: "true" }
    : undefined;
  return ctx.http.get<EngineDomainStatus>("/v1/admin/domain", query);
}

/**
 * Resolve the active provider id for the 501 message — best-effort via the
 * always-200 GET; falls back to a generic label when even that fails.
 */
async function providerLabel(ctx: CommandContext): Promise<string> {
  try {
    const status = await getStatus(ctx);
    return status.providerId;
  } catch {
    return "the active email provider";
  }
}

/** Map a provider_unsupported 501 (or rethrow anything else). */
async function failUnsupported(
  ctx: CommandContext,
  err: unknown,
): Promise<never> {
  if (isHttpError(err) && err.status === 501) {
    const provider = await providerLabel(ctx);
    ctx.out.fail(
      `provider ${provider} does not support domain management — ` +
        "verify the domain in your provider's dashboard instead",
    );
  }
  throw err;
}

/** One status line per DNS record (the per-poll tick view). */
function recordTicks(records: DnsRecord[]): string {
  return records
    .map((r) => {
      const tick =
        r.status === "verified"
          ? color.green("✓")
          : r.status === "failed"
            ? color.red("✗")
            : color.yellow("…");
      return `  ${tick} ${r.type.padEnd(5)} ${r.name}  ${color.dim(r.status)}`;
    })
    .join("\n");
}

/** Human view of an EngineDomainStatus (status + check share it). */
function renderStatus(ctx: CommandContext, status: EngineDomainStatus): void {
  ctx.out.kv({
    domain: status.domain ?? "(not configured)",
    provider: status.providerId,
    supported: status.supported,
    state: status.status?.state ?? "n/a",
    checkedAt: status.status?.checkedAt ?? "",
  });
  const records = status.status?.records ?? [];
  if (records.length > 0) {
    ctx.out.log("");
    ctx.out.table(
      records.map((r) => ({
        type: r.type,
        name: r.name,
        value: r.value,
        priority: r.priority ?? "",
        purpose: r.purpose,
        status: r.status,
      })),
    );
  }
  if (status.testMode.active) {
    ctx.out.log("");
    ctx.out.log(
      `${color.bgYellow(color.black(" TEST MODE "))} ${color.yellow(
        `all sends redirect to ${status.testMode.redirectTo ?? "(no redirect address!)"}` +
          ` — reason: ${status.testMode.reason ?? "unknown"}`,
      )}`,
    );
    if (!status.testMode.redirectTo) {
      ctx.out.log(
        color.dim(
          "  set HOGSEND_TEST_EMAIL (or STUDIO_ADMIN_EMAIL) — sends are BLOCKED until one is configured",
        ),
      );
    }
  } else if (status.status?.state === "verified") {
    // Domain verified + test mode off → sends go to real recipients.
    ctx.out.log("");
    ctx.out.log(`${color.green("✓")} sends live`);
  }
}

// ---------------------------------------------------------------------------
// add <domain>
// ---------------------------------------------------------------------------

async function runAdd(ctx: CommandContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      apply: { type: "boolean", default: false },
      "no-apply": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  const domain = positionals[0];
  if (!domain) {
    ctx.out.fail("missing <domain> — usage: hogsend domain add <domain>");
  }
  if (!DOMAIN_RE.test(domain)) {
    ctx.out.fail(`invalid domain "${domain}" (expected e.g. mysite.com)`);
  }

  ctx.out.intro(badge);

  let status: EngineDomainStatus;
  try {
    status = await ctx.out.step(`Registering ${domain} with the provider`, () =>
      ctx.http.post<EngineDomainStatus>("/v1/admin/domain", { domain }),
    );
  } catch (err) {
    return failUnsupported(ctx, err);
  }

  const records = status.status?.records ?? [];
  const host = await detectDnsHost(domain);

  let applyResult: Awaited<ReturnType<typeof applyRecords>> | null = null;
  const autoAvailable = canAutoApply(host.id, process.env);
  if (autoAvailable && records.length > 0) {
    const doApply = values.apply
      ? true
      : values["no-apply"]
        ? false
        : ctx.out.interactive
          ? bail(
              await confirm({
                message: `Apply these records via the ${host.label} API?`,
                initialValue: true,
              }),
            )
          : false; // non-TTY default: never write DNS without an explicit --apply
    if (doApply) {
      applyResult = await ctx.out.step(
        `Applying ${records.length} record(s) via ${host.label}`,
        () =>
          applyRecords({ host: host.id, domain, records, env: process.env }),
      );
    }
  }

  if (ctx.json) {
    ctx.out.json({
      status,
      dnsHost: host.id,
      panelUrl: host.panelUrl(domain),
      autoApplyAvailable: autoAvailable,
      applied: applyResult,
    });
    return;
  }

  ctx.out.log("");
  ctx.out.log(formatRecordsFor(host, records, { domain }));
  ctx.out.log("");
  ctx.out.log(
    `${color.dim("DNS panel:")} ${color.cyan(host.panelUrl(domain))}`,
  );

  if (applyResult) {
    ctx.out.log("");
    ctx.out.log(
      `${color.green("applied")} ${applyResult.applied.length}  ` +
        `${color.yellow("skipped")} ${applyResult.skipped.length}  ` +
        `${color.red("errors")} ${applyResult.errors.length}`,
    );
    for (const error of applyResult.errors) {
      ctx.out.log(`  ${color.red("✗")} ${error}`);
    }
  } else if (autoAvailable && records.length > 0) {
    ctx.out.log("");
    ctx.out.log(
      color.dim(
        `Auto-apply available — rerun with --apply to write them via ${host.label}.`,
      ),
    );
  }

  ctx.out.outro(
    `Records added? Run ${color.cyan("hogsend domain check")} to poll verification.`,
  );
}

// ---------------------------------------------------------------------------
// check [<domain>]
// ---------------------------------------------------------------------------

async function runCheck(ctx: CommandContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      timeout: { type: "string", default: "300" },
      once: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  const timeoutSecs = Number(values.timeout);
  if (!Number.isFinite(timeoutSecs) || timeoutSecs <= 0) {
    ctx.out.fail(`invalid --timeout "${values.timeout}" (expected seconds)`);
  }

  ctx.out.intro(badge);

  // Verification always runs against the instance's CONFIGURED domain
  // (EMAIL_DOMAIN / EMAIL_FROM) — surface a mismatch instead of silently
  // ignoring the positional.
  const requested = positionals[0];
  if (requested) {
    const current = await getStatus(ctx);
    if (current.domain && current.domain !== requested.toLowerCase()) {
      ctx.out.log(
        color.yellow(
          `note: the instance's configured sending domain is ${current.domain}; ` +
            `checking that (not ${requested}). Set EMAIL_DOMAIN to change it.`,
        ),
      );
    }
  }

  // Kick a provider-side verification pass first (Resend verify; providers
  // without one fall back to a status fetch server-side).
  try {
    await ctx.out.step("Triggering provider verification", () =>
      ctx.http.post<EngineDomainStatus>("/v1/admin/domain/verify", {}),
    );
  } catch (err) {
    if (isHttpError(err) && err.status === 400) {
      ctx.out.fail(
        "no sending domain configured — set EMAIL_DOMAIN (or EMAIL_FROM), " +
          "or run `hogsend domain add <domain>` first",
      );
    }
    return failUnsupported(ctx, err);
  }

  const deadline = Date.now() + timeoutSecs * 1000;
  for (;;) {
    const status = await getStatus(ctx, { refresh: true });
    const records = status.status?.records ?? [];
    if (records.length > 0) {
      ctx.out.log(recordTicks(records));
    }

    if (status.status?.state === "verified") {
      if (ctx.json) {
        ctx.out.json(status);
        return;
      }
      renderStatus(ctx, status);
      ctx.out.outro(`${color.green("Verified.")} ${status.domain} is live.`);
      return;
    }

    if (values.once) {
      if (ctx.json) {
        ctx.out.json(status);
        process.exitCode = 1;
        return;
      }
      ctx.out.fail(
        `domain is ${status.status?.state ?? "not configured"} (not verified)`,
      );
    }

    if (Date.now() + POLL_INTERVAL_MS > deadline) {
      ctx.out.fail(
        `timed out after ${timeoutSecs}s — DNS can take a while to propagate; ` +
          "rerun `hogsend domain check` later",
      );
    }

    ctx.out.log(
      color.dim(
        `state: ${status.status?.state ?? "unknown"} — polling again in 15s ...`,
      ),
    );
    await sleep(POLL_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function runStatus(ctx: CommandContext, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      refresh: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  const status = await getStatus(ctx, { refresh: values.refresh });

  if (ctx.json) {
    ctx.out.json(status);
    return;
  }

  ctx.out.intro(badge);
  renderStatus(ctx, status);
  if (!status.supported) {
    ctx.out.log("");
    ctx.out.log(
      color.dim(
        `provider ${status.providerId} does not support domain management — ` +
          "verify the domain in your provider's dashboard",
      ),
    );
  }
  ctx.out.outro("Done.");
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

async function run(ctx: CommandContext): Promise<void> {
  const sub = ctx.argv[0];
  const rest = ctx.argv.slice(1);

  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    ctx.out.log(usage);
    return;
  }

  switch (sub) {
    case "add":
      return runAdd(ctx, rest);
    case "check":
      return runCheck(ctx, rest);
    case "status":
      return runStatus(ctx, rest);
    default:
      ctx.out.fail(
        `unknown subcommand "${sub}" — expected add | check | status`,
      );
  }
}

export const domainCommand: Command = {
  name: "domain",
  summary: "Set up + verify the sending domain (DNS records, auto-apply)",
  usage,
  run,
};
