import { parseArgs } from "node:util";
import { password as passwordPrompt, text } from "@clack/prompts";
import {
  type AdminRecovery,
  AdminRecoveryConfigError,
  type AdminSummary,
  createAdminRecovery,
} from "../lib/admin-recovery.js";
import { color } from "../lib/output.js";
import { bail } from "../lib/prompt.js";
import type { CommandContext } from "./types.js";

/**
 * `hogsend studio admin <create|reset|list>` — the shell-gated Studio admin
 * recovery primitive. Routed here from the `studio` command's subcommand
 * dispatch.
 *
 * Security posture (see lib/admin-recovery.ts for the invariants):
 *  - Gated by holding both DATABASE_URL and BETTER_AUTH_SECRET. No HTTP.
 *  - Passwords go ONLY through better-auth's server API (scrypt). No raw SQL.
 *  - The password is NEVER echoed (masked prompt) and NEVER logged. When the
 *    `--password` flag is used we warn (interactively) about shell history.
 */

export const adminUsage = `hogsend studio admin <command> [options]

Shell-gated Studio admin recovery (PostHog/GitLab/Rails-style). Constructs a
better-auth instance directly against your database and uses better-auth's
server API so password hashing is identical to the running app. NO HTTP and no
running API are required — this is gated by holding the DB URL and app secret.

DATABASE_URL and BETTER_AUTH_SECRET are read from the ENVIRONMENT only (not from
a .env file). Run with your app env loaded, e.g.
  dotenvx run -- hogsend studio admin create
  railway run hogsend studio admin create
  pnpm studio:admin              # the scaffold's env-loaded wrapper

Commands:
  ${color.cyan("create")}   Create a Studio admin user (the first admin, or another).
  ${color.cyan("reset")}    Set a new password for an existing admin (by email).
  ${color.cyan("list")}     List existing admins (id, email, name, createdAt). No secrets.

Options:
  --email <e>          Admin email (required; prompted in a TTY if omitted).
  --name <n>           Display name for create (defaults to the email local-part).
  --password <p>       Password for create/reset. PREFER the masked prompt — a
                       value passed here can leak into your shell history.
  --no-revoke          (reset) Keep existing sessions instead of revoking them.
  --database-url <u>   Override DATABASE_URL (else read from the environment).
  --json               Emit a single JSON result document (non-interactive).
  -h, --help           Show this help.

Examples:
  hogsend studio admin create --email admin@example.com
  hogsend studio admin reset --email admin@example.com
  hogsend studio admin list --json

Security: passwords are written ONLY via better-auth (scrypt) — never raw SQL,
never plaintext at rest, never logged. Prefer the masked prompt over --password.`;

interface AdminFlags {
  email?: string;
  name?: string;
  password?: string;
  revoke: boolean;
  databaseUrl?: string;
}

/** Parse the admin subcommand argv (after the `admin <sub>` tokens). */
function parseAdminFlags(argv: string[]): AdminFlags {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      email: { type: "string" },
      name: { type: "string" },
      password: { type: "string" },
      revoke: { type: "boolean", default: true },
      "database-url": { type: "string" },
    },
  });
  return {
    email: typeof values.email === "string" ? values.email : undefined,
    name: typeof values.name === "string" ? values.name : undefined,
    password: typeof values.password === "string" ? values.password : undefined,
    revoke: values.revoke !== false,
    databaseUrl:
      typeof values["database-url"] === "string"
        ? values["database-url"]
        : undefined,
  };
}

/**
 * Resolve the gating env (DATABASE_URL + BETTER_AUTH_SECRET) from flags then
 * `process.env` ONLY — there is no cwd `.env` read here (consistent with
 * `db:migrate`, which also reads the environment directly). Holding both IS the
 * gate; there is no HTTP fallback. Fails fast and clearly if either is missing,
 * telling the operator how to run the command with its env loaded.
 */
function resolveGatingEnv(
  ctx: CommandContext,
  flags: AdminFlags,
): { databaseUrl: string; secret: string; baseURL: string | undefined } {
  const databaseUrl = flags.databaseUrl ?? process.env.DATABASE_URL;
  const secret = process.env.BETTER_AUTH_SECRET;
  const baseURL = process.env.BETTER_AUTH_URL ?? process.env.API_PUBLIC_URL;

  const missing: string[] = [];
  if (!databaseUrl) missing.push("DATABASE_URL");
  if (!secret) missing.push("BETTER_AUTH_SECRET");
  if (missing.length > 0) {
    ctx.out.fail(
      `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} ` +
        "required, and are read from the environment only (not a .env file). " +
        "Run this command with your app env loaded, e.g.\n" +
        "  export DATABASE_URL=… BETTER_AUTH_SECRET=…\n" +
        "  dotenvx run -- hogsend studio admin create\n" +
        "  railway run hogsend studio admin create\n" +
        "  pnpm studio:admin            # the scaffold's env-loaded wrapper\n" +
        "This command is gated by DB + secret access (no HTTP fallback).",
    );
  }

  // Non-null assertions are safe: ctx.out.fail above exits the process.
  return {
    databaseUrl: databaseUrl as string,
    secret: secret as string,
    baseURL,
  };
}

/** Prompt for an email in a TTY, or fail with guidance otherwise. */
async function resolveEmail(
  ctx: CommandContext,
  flags: AdminFlags,
  defaultEmail?: string,
): Promise<string> {
  if (flags.email && flags.email.length > 0) return flags.email;
  if (!ctx.out.interactive) {
    ctx.out.fail("--email is required (no TTY to prompt).");
  }
  const value = bail(
    await text({
      message: "Admin email",
      placeholder: defaultEmail ?? "admin@example.com",
      initialValue: defaultEmail,
      validate: (v) =>
        v?.includes("@") ? undefined : "Enter a valid email address.",
    }),
  );
  return value.trim();
}

/**
 * Resolve a password: from the flag if provided (with an interactive shell-
 * history warning), otherwise via a masked prompt typed twice (confirm).
 * NEVER echoed, NEVER logged.
 */
async function resolvePassword(
  ctx: CommandContext,
  flags: AdminFlags,
): Promise<string> {
  if (flags.password && flags.password.length > 0) {
    if (ctx.out.interactive) {
      ctx.out.log(
        color.yellow(
          "warning: --password can leak into your shell history; " +
            "prefer the masked prompt next time.",
        ),
      );
    }
    return flags.password;
  }
  if (!ctx.out.interactive) {
    ctx.out.fail(
      "--password is required (no TTY for the masked prompt). " +
        "Note: a value passed via --password may leak into shell history.",
    );
  }
  const first = bail(
    await passwordPrompt({
      message: "New password (min 8 chars)",
      validate: (v) =>
        v && v.length >= 8 ? undefined : "Password must be at least 8 chars.",
    }),
  );
  const second = bail(
    await passwordPrompt({
      message: "Confirm password",
      validate: (v) => (v === first ? undefined : "Passwords do not match."),
    }),
  );
  if (first !== second) {
    ctx.out.fail("Passwords do not match.");
  }
  return first;
}

/** Render an admin summary for human output (no secrets present in the type). */
function printAdmin(ctx: CommandContext, action: string, admin: AdminSummary) {
  ctx.out.kv(
    {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      createdAt: admin.createdAt,
    },
    `${action} admin`,
  );
}

async function runCreate(
  ctx: CommandContext,
  flags: AdminFlags,
  recovery: AdminRecovery,
): Promise<void> {
  const email = await resolveEmail(ctx, flags);
  const passwordValue = await resolvePassword(ctx, flags);
  const admin = await recovery.create({
    email,
    password: passwordValue,
    name: flags.name,
  });
  if (ctx.json) {
    ctx.out.json({ action: "create", admin });
    return;
  }
  printAdmin(ctx, "Created", admin);
  ctx.out.outro(`${color.green("✓")} Admin created. You can now sign in.`);
}

async function runReset(
  ctx: CommandContext,
  flags: AdminFlags,
  recovery: AdminRecovery,
): Promise<void> {
  // If exactly one admin exists and --email is omitted in a TTY, offer it.
  let defaultEmail: string | undefined;
  if (!flags.email && ctx.out.interactive) {
    const admins = await recovery.list();
    if (admins.length === 1) defaultEmail = admins[0]?.email;
  }
  const email = await resolveEmail(ctx, flags, defaultEmail);
  const passwordValue = await resolvePassword(ctx, flags);
  const admin = await recovery.reset({
    email,
    password: passwordValue,
    revokeSessions: flags.revoke,
  });
  if (ctx.json) {
    ctx.out.json({ action: "reset", admin, revokedSessions: flags.revoke });
    return;
  }
  printAdmin(ctx, "Reset password for", admin);
  ctx.out.outro(
    `${color.green("✓")} Password reset.` +
      (flags.revoke ? " Existing sessions were revoked." : ""),
  );
}

async function runList(
  ctx: CommandContext,
  recovery: AdminRecovery,
): Promise<void> {
  const admins = await recovery.list();
  if (ctx.json) {
    ctx.out.json(admins);
    return;
  }
  if (admins.length === 0) {
    ctx.out.note(
      "No admins exist yet. Create one with `hogsend studio admin create`.",
      "Admins",
    );
    return;
  }
  ctx.out.table(
    admins.map((a) => ({ ...a })),
    ["id", "email", "name", "createdAt"],
  );
}

/**
 * Entry point for `hogsend studio admin ...`. `argv` is everything AFTER the
 * `admin` token (i.e. the subcommand + its flags). Routed from `studio.ts`.
 */
export async function runStudioAdmin(
  ctx: CommandContext,
  argv: string[],
): Promise<void> {
  const [sub, ...rest] = argv;

  if (!sub || sub === "-h" || sub === "--help") {
    ctx.out.log(adminUsage);
    if (!sub) return;
    return;
  }

  if (!["create", "reset", "list"].includes(sub)) {
    ctx.out.log(adminUsage);
    ctx.out.fail(`unknown subcommand "${sub}"`);
  }

  // Per-subcommand --help.
  if (rest.includes("-h") || rest.includes("--help")) {
    ctx.out.log(adminUsage);
    return;
  }

  const flags = parseAdminFlags(rest);
  const env = resolveGatingEnv(ctx, flags);

  let recovery: AdminRecovery;
  try {
    recovery = createAdminRecovery({
      databaseUrl: env.databaseUrl,
      secret: env.secret,
      baseURL: env.baseURL,
    });
  } catch (err) {
    if (err instanceof AdminRecoveryConfigError) {
      ctx.out.fail(err.message);
    }
    throw err;
  }

  try {
    if (sub === "create") {
      await runCreate(ctx, flags, recovery);
    } else if (sub === "reset") {
      await runReset(ctx, flags, recovery);
    } else {
      await runList(ctx, recovery);
    }
  } finally {
    await recovery.close();
  }
}
