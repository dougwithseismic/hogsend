import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isCloudError } from "../lib/cloud-http.js";
import { describeCloudRefusal, formatRefusal } from "../lib/cloud-refusals.js";
import { NotLoggedInError, requireCloudSession } from "../lib/cloud-session.js";
import { mergeEnv } from "../lib/env-file.js";
import { color } from "../lib/output.js";
import {
  type EnvironmentListResponse,
  PublishError,
  selectEnvironment,
} from "../lib/publish-flow.js";
import { findScaffoldRoot } from "../lib/publish-manifest.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend env <command> [options]

Commands:
  pull               Write this Hogsend Cloud environment's URL and API key into .env.

Pull merges HOGSEND_API_URL and HOGSEND_API_KEY into the .env beside your app —
it never rewrites the file. Existing variables, comments and ordering survive,
and a key already set to a DIFFERENT value is reported and refused rather than
clobbered; pass --force when replacing it is what you meant.

The key is never printed. You are told that it was written and where, never
what it is, because CLI output lands in scrollback, CI logs and screen shares.

Options:
  --env <name>       Environment to pull from (default: your production environment).
  --force            Replace HOGSEND_API_URL / HOGSEND_API_KEY if already set differently.
  --cloud <url>      Cloud host (default HOGSEND_CLOUD_URL, else https://cloud.hogsend.com).
  --cwd <dir>        Start the scaffold-root search here (default: the current directory).
  --json             Emit a single JSON result. Never contains the key.
  -h, --help         Show this help.

Exit codes:
  0  the credentials were written (or were already in place)
  1  refused or failed

Examples:
  hogsend env pull
  hogsend env pull --env staging
  hogsend env pull --force`;

const badge = `${color.bgMagenta(color.black(" hogsend "))} env pull`;

const COMMENT = "Hogsend Cloud — written by `hogsend env pull`";

/**
 * Where the `.env` belongs.
 *
 * The scaffold root when there is one, because that is where the app reads it
 * from and where `publish` packs from. When there is not — an empty directory
 * someone is about to scaffold into, or a repo whose app lives elsewhere — the
 * given directory, rather than refusing: pulling credentials is useful BEFORE
 * there is an app, and a refusal here would just make people paste by hand.
 */
function resolveEnvPath(cwd: string): string {
  try {
    return join(findScaffoldRoot(cwd).dir, ".env");
  } catch {
    return join(cwd, ".env");
  }
}

async function pull(ctx: CommandContext, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      env: { type: "string" },
      force: { type: "boolean", default: false },
      cloud: { type: "string" },
      cwd: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  const cloudOpts = values.cloud === undefined ? {} : { cloud: values.cloud };

  let session: ReturnType<typeof requireCloudSession>;
  try {
    session = requireCloudSession(cloudOpts);
  } catch (error) {
    if (error instanceof NotLoggedInError) {
      ctx.out.fail(`${error.message} ${error.hint}`);
    }
    throw error;
  }

  const refusalContext = {
    cloudHost: session.cloud.host,
    cloudExplicit: session.cloud.explicit,
    ...(values.env === undefined ? {} : { envName: values.env }),
  };

  const fail = (error: unknown): never => {
    if (error instanceof PublishError) {
      ctx.out.fail(
        error.hint ? `${error.message} ${error.hint}` : error.message,
      );
    }
    if (isCloudError(error)) {
      ctx.out.fail(formatRefusal(describeCloudRefusal(error, refusalContext)));
    }
    throw error;
  };

  ctx.out.intro(badge);

  // The same resolution `publish` uses — one list endpoint, one selector, so
  // `--env staging` cannot mean two different environments in two commands.
  let environment: ReturnType<typeof selectEnvironment>;
  let credentials: { apiUrl: string; apiKey: string };
  try {
    const listed = await ctx.out.step("Resolving environment", () =>
      session.client.get<EnvironmentListResponse>("/api/cli/environments"),
    );
    environment = selectEnvironment(listed.environments, values.env);
    credentials = await ctx.out.step("Fetching credentials", () =>
      session.client.get<{ apiUrl: string; apiKey: string }>(
        `/api/cli/environments/${environment.id}/credentials`,
      ),
    );
  } catch (error) {
    return fail(error);
  }

  const path = resolveEnvPath(values.cwd ?? process.cwd());
  const existed = existsSync(path);
  const before = existed ? readFileSync(path, "utf8") : "";

  const merged = mergeEnv(
    before,
    {
      HOGSEND_API_URL: credentials.apiUrl,
      HOGSEND_API_KEY: credentials.apiKey,
    },
    { force: values.force === true, comment: COMMENT },
  );

  if (merged.conflicts.length > 0) {
    ctx.out.fail(
      `${path} already sets ${merged.conflicts.join(" and ")} to a different value, so nothing was written.\n  Re-run with --force to replace ${merged.conflicts.length === 1 ? "it" : "them"}, or remove the ${merged.conflicts.length === 1 ? "line" : "lines"} yourself.`,
    );
  }

  if (merged.changed) {
    // 0600 on creation: this file is about to hold a secret key, and inheriting
    // a umask that makes it group-readable is not a default worth accepting.
    writeFileSync(path, merged.content, { encoding: "utf8", mode: 0o600 });
  }

  // `mode` above applies only to a file this call CREATED, so an existing loose
  // permission is reported rather than silently tightened — narrowing a file
  // someone else's tooling reads would break them without saying so.
  const loose =
    existed && merged.changed && (statSync(path).mode & 0o077) !== 0;

  const outcomes = Object.fromEntries(
    merged.results.map((row) => [row.key, row.outcome]),
  );

  if (ctx.json) {
    // Names and outcomes only. There is no branch of this command that puts
    // `credentials.apiKey` on stdout.
    ctx.out.json({
      pulled: true,
      path,
      created: !existed,
      changed: merged.changed,
      environment: { id: environment.id, name: environment.name },
      apiUrl: credentials.apiUrl,
      variables: outcomes,
    });
    return;
  }

  const wrote = merged.results
    .filter((row) => row.outcome !== "unchanged")
    .map((row) => row.key);

  ctx.out.log(
    color.dim(
      `  ${environment.name} → ${path}${existed ? "" : " (created)"} · ${credentials.apiUrl}`,
    ),
  );
  if (loose) {
    ctx.out.log(
      color.dim(
        "  note: this .env is readable beyond your user. `chmod 600` it — it now holds an API key.",
      ),
    );
  }
  const verdict =
    wrote.length === 0
      ? "Already up to date."
      : `Wrote ${wrote.join(" and ")}. The key is not printed — it is in the file.`;

  // An outro is TTY-only, and this line is the whole answer — a CI run that saw
  // nothing at all could not tell a successful pull from a no-op. So it goes to
  // `log` when there is no terminal to draw chrome in.
  if (ctx.out.interactive) ctx.out.outro(verdict);
  else ctx.out.log(`${color.green("✓")} ${verdict}`);
}

async function run(ctx: CommandContext): Promise<void> {
  const [sub, ...rest] = ctx.argv;

  if (sub === undefined || sub === "-h" || sub === "--help") {
    ctx.out.log(usage);
    return;
  }
  if (sub === "pull") return pull(ctx, rest);

  ctx.out.fail(`Unknown subcommand "${sub}". Try \`hogsend env pull\`.`);
}

export const envCommand: Command = {
  name: "env",
  summary: "Pull a Hogsend Cloud environment's URL and API key into .env",
  usage,
  run,
};
