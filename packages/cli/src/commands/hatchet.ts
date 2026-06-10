import { parseArgs } from "node:util";
import { HatchetTokenError, mintHatchetToken } from "../lib/hatchet-token.js";
import { color } from "../lib/output.js";
import type { Command, CommandContext } from "./types.js";

/**
 * `hogsend hatchet token` — mint a HATCHET_CLIENT_TOKEN headlessly against a
 * hatchet-lite instance (register-or-login → ensure tenant → create API token)
 * so the Railway-template "copy the token out of the dashboard" step goes away.
 *
 * Output contract: on success the ONLY thing written to stdout is the token
 * (+ newline) so it pipes cleanly into `railway variables --set` etc. All
 * progress goes to stderr; --json swaps stdout for a single JSON document.
 */

const usage = `hogsend hatchet token [options]

Mint a Hatchet API token (HATCHET_CLIENT_TOKEN) headlessly against a
hatchet-lite instance. Registers the account if the instance still allows
signups, otherwise logs in (e.g. with the seeded ADMIN_EMAIL/ADMIN_PASSWORD on
a locked-down deployment), ensures the tenant exists, and creates the token.

On success the token is the ONLY thing printed to stdout — pipe it straight
into your platform's variable store. Progress and errors go to stderr.

Options:
  --url <hatchet-url>    Hatchet base URL (or HATCHET_URL), e.g. the
                         hatchet-lite service's public https URL. Required —
                         this command never falls back to HOGSEND_API_URL or
                         the localhost default (those target your Hogsend
                         API, not Hatchet). NOTE: for this command the global
                         --url targets HATCHET, not your Hogsend API.
  --email <e>            Account email (or HATCHET_ADMIN_EMAIL).
  --password <p>         Account password (or HATCHET_ADMIN_PASSWORD). Prefer
                         the env var — flags can leak into shell history.
  --tenant <slug>        Tenant slug (default "default", the seeded tenant).
                         Created (engine V1) if it doesn't exist yet.
  --token-name <n>       Display name for the minted token (default "hogsend").
  --json                 Emit { token, tenantId, ... } as one JSON document.
  -h, --help             Show this help.

Examples:
  hogsend hatchet token --url https://hatchet-lite-production.up.railway.app \\
    --email admin@example.com --password 'Admin123!!'
  HATCHET_ADMIN_PASSWORD=... hogsend hatchet token --url https://... --email admin@acme.com
  railway variables --service hogsend-worker \\
    --set "HATCHET_CLIENT_TOKEN=$(hogsend hatchet token --url ... --email ... --password ...)"

Lockdown note: hatchet-lite ships with OPEN registration — anyone who finds the
public URL can create an account. On a public deployment set
SERVER_ALLOW_SIGNUP=false (plus a real ADMIN_EMAIL/ADMIN_PASSWORD, which
hatchet-lite seeds at boot); this command then logs in with those credentials.`;

interface TokenFlags {
  url?: string;
  email?: string;
  password?: string;
  tenant?: string;
  tokenName?: string;
}

function parseTokenFlags(argv: string[]): TokenFlags {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      url: { type: "string" },
      email: { type: "string" },
      password: { type: "string" },
      tenant: { type: "string" },
      "token-name": { type: "string" },
    },
  });
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;
  return {
    url: str(values.url),
    email: str(values.email),
    password: str(values.password),
    tenant: str(values.tenant),
    tokenName: str(values["token-name"]),
  };
}

/**
 * Terminal failure that honors the stdout-is-only-the-token contract: human
 * mode always writes to stderr (even in a TTY — clack's cancel would land on
 * stdout); --json keeps the single-JSON-document contract via out.fail.
 */
function failToStderr(ctx: CommandContext, message: string): never {
  if (ctx.json) {
    ctx.out.fail(message);
  }
  process.stderr.write(`${color.red("error")} ${message}\n`);
  process.exit(1);
}

async function runToken(ctx: CommandContext, argv: string[]): Promise<void> {
  const flags = parseTokenFlags(argv);

  // The router owns the global `--url` and resolves it into cfg.baseUrl before
  // this command sees argv — an explicit `--url <hatchet-url>` arrives as
  // cfg.baseUrl with cfg.urlExplicit set. We deliberately do NOT fall back to
  // cfg.baseUrl otherwise: it ALWAYS resolves (HOGSEND_API_URL env/.env, then
  // localhost:3002), which would silently POST the Hatchet admin credentials
  // to the Hogsend API with a misleading login error. Without an explicit
  // --url, HATCHET_URL is required and the missing-url error below fires. The
  // local flag parse is kept first for safety should the router ever stop
  // owning --url.
  const url =
    flags.url ??
    (ctx.cfg.urlExplicit ? ctx.cfg.baseUrl : undefined) ??
    process.env.HATCHET_URL;
  const email = flags.email ?? process.env.HATCHET_ADMIN_EMAIL;
  const password = flags.password ?? process.env.HATCHET_ADMIN_PASSWORD;

  const missing: string[] = [];
  if (!url) missing.push("--url (or HATCHET_URL)");
  if (!email) missing.push("--email (or HATCHET_ADMIN_EMAIL)");
  if (!password) missing.push("--password (or HATCHET_ADMIN_PASSWORD)");
  if (missing.length > 0 || !url || !email || !password) {
    failToStderr(ctx, `missing ${missing.join(", ")}`);
  }

  // Progress goes to stderr ONLY — stdout is reserved for the token.
  const onProgress = ctx.json
    ? undefined
    : (msg: string) => process.stderr.write(`${color.dim(msg)}\n`);
  onProgress?.(`hatchet: ${url}`);

  try {
    const result = await mintHatchetToken({
      url,
      email,
      password,
      tenantSlug: flags.tenant,
      tokenName: flags.tokenName,
      onProgress,
    });

    if (ctx.json) {
      ctx.out.json(result);
      return;
    }
    process.stdout.write(`${result.token}\n`);
  } catch (err) {
    if (err instanceof HatchetTokenError) {
      failToStderr(ctx, err.message);
    }
    throw err;
  }
}

async function run(ctx: CommandContext): Promise<void> {
  const sub = ctx.argv[0];
  const rest = ctx.argv.slice(1);

  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    ctx.out.log(usage);
    return;
  }
  if (rest.includes("-h") || rest.includes("--help")) {
    ctx.out.log(usage);
    return;
  }

  switch (sub) {
    case "token":
      return runToken(ctx, rest);
    default:
      failToStderr(ctx, `unknown subcommand "${sub}" — expected token`);
  }
}

export const hatchetCommand: Command = {
  name: "hatchet",
  summary: "Hatchet helpers — mint a HATCHET_CLIENT_TOKEN headlessly",
  usage,
  run,
};
