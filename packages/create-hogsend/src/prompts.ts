import { basename } from "node:path";
import { stdin, stdout } from "node:process";
import { parseArgs } from "node:util";
import {
  cancel,
  confirm,
  isCancel,
  log,
  multiselect,
  select,
  text,
} from "@clack/prompts";

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

export interface CliOptions {
  /** Target directory relative to cwd: "." for the current folder, or a name. */
  dir: string;
  /** Sanitized package/display name (derived from the folder when dir is "."). */
  appName: string;
  packageManager: PackageManager;
  install: boolean;
  git: boolean;
  /** Emit `.claude/skills/` + a tailored `CLAUDE.md` for Claude Code agents. */
  skills: boolean;
  /** Run `pnpm bootstrap` after install (Docker, .env, Hatchet token, migrate). */
  setup: boolean;
  /**
   * Sending domain (e.g. "mysite.com"). When set, the scaffolded `env.example`
   * gets `EMAIL_FROM=hello@<domain>` + `EMAIL_DOMAIN=<domain>` (and bootstrap's
   * `.env` copy inherits them).
   */
  domain?: string;
  /**
   * PostHog project config. When set, the scaffolded `env.example` gets active
   * `POSTHOG_API_KEY` + `POSTHOG_HOST` values, `ENABLE_POSTHOG_DESTINATION=true`,
   * and a freshly minted `POSTHOG_WEBHOOK_SECRET` (and bootstrap's `.env` copy
   * inherits them).
   */
  posthog?: PosthogOptions;
  /**
   * The user is using PostHog, regardless of whether a key was pasted. Gates the
   * post-deploy `hogsend connect posthog` next-step hint (the `posthog` field is
   * only set when an actual key was supplied, so it can't gate the finisher).
   */
  usingPosthog: boolean;
  /** TEST-ONLY: resolve `@hogsend/*` from `file:` tarballs in this dir. */
  useTarballs?: string;
}

export interface PosthogOptions {
  /** PostHog project API key (`phc_...`). */
  apiKey: string;
  /** PostHog host URL, e.g. https://eu.i.posthog.com. */
  host: string;
}

const VALID_PMS: PackageManager[] = ["pnpm", "npm", "yarn", "bun"];

/**
 * Idiomatic "run a locally-installed bin" per pm. The `hogsend` CLI ships with
 * the app's dependencies (`@hogsend/cli`), NOT on the global PATH — a bare
 * `hogsend …` hint sends users straight into `command not found`, and
 * `npx hogsend` OUTSIDE the app dir installs the registry version (stale, and
 * with no `.env` in cwd it can't resolve the admin key either).
 */
export function binCmd(pm: PackageManager, bin: string): string {
  switch (pm) {
    case "npm":
      return `npx ${bin}`; // npx prefers the local node_modules bin
    case "yarn":
      return `yarn ${bin}`;
    case "bun":
      return `bunx ${bin}`;
    default:
      return `pnpm ${bin}`;
  }
}

export const USAGE = `
create-hogsend — scaffold a Hogsend lifecycle orchestration app.

Usage:
  pnpm dlx create-hogsend <app-name> [options]
  pnpm dlx create-hogsend .            # scaffold into the current folder

Options:
  -y, --yes                  Accept all defaults, no prompts (install + setup)
  --pm <pnpm|npm|yarn|bun>   Package manager (default: pnpm)
  --domain <domain>          Sending domain — writes EMAIL_FROM=hello@<domain>
                             + EMAIL_DOMAIN=<domain> into env.example
  --posthog-key <phc_...>    PostHog project API key — writes POSTHOG_API_KEY +
                             POSTHOG_HOST as active values, sets
                             ENABLE_POSTHOG_DESTINATION=true and mints a
                             POSTHOG_WEBHOOK_SECRET in env.example
  --posthog-host <url>       PostHog host URL (default: https://us.i.posthog.com;
                             requires --posthog-key)
  --no-posthog               Skip the "Where will events come from?" prompt
  --setup                    Run local setup after install (Docker, .env, migrate)
  --no-setup                 Skip local setup
  --no-install               Skip dependency install
  --no-git                   Skip git init + initial commit
  --skills / --no-skills     Include (default) or skip Claude Code skills + CLAUDE.md
  --use-tarballs <dir>       TEST-ONLY: resolve @hogsend/* from local tarballs
  -h, --help                 Show this help

Run with no app name in a terminal for an interactive setup.
Docs: docs.hogsend.com
`.trim();

const APP_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** Pinned sending-domain validation regex (matches the engine's admin route). */
const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

function validateDomain(value: string): string | undefined {
  if (!DOMAIN_RE.test(value)) {
    return `Invalid domain "${value}" — expected something like mysite.com.`;
  }
  return undefined;
}

export const POSTHOG_EU_HOST = "https://eu.i.posthog.com";
export const POSTHOG_US_HOST = "https://us.i.posthog.com";

function validatePosthogKey(value: string): string | undefined {
  if (!/^phc_.+$/.test(value)) {
    return `Invalid PostHog key "${value}" — project API keys start with "phc_".`;
  }
  return undefined;
}

function validatePosthogHost(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `Invalid PostHog host "${value}" — expected a URL like ${POSTHOG_EU_HOST}.`;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return `Invalid PostHog host "${value}" — must be an http(s) URL.`;
  }
  return undefined;
}

/** Drop trailing slashes so the emitted POSTHOG_HOST env value stays tidy. */
function normalizePosthogHost(value: string): string {
  return value.replace(/\/+$/, "");
}

/** "mysite.com" → "mysite" (the default app name when only --domain is given). */
function firstDomainLabel(domain: string): string {
  return domain.toLowerCase().split(".")[0] ?? domain.toLowerCase();
}

function isPackageManager(value: string): value is PackageManager {
  return (VALID_PMS as string[]).includes(value);
}

/** Coerce an arbitrary folder name into a valid npm-ish package name. */
function sanitizeName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "");
  return cleaned || "hogsend-app";
}

function validateAppName(name: string | undefined): string | undefined {
  if (!name) return "Project name is required.";
  if (name === "." || name === "./") return undefined;
  if (!APP_NAME_RE.test(name)) {
    return 'Use lowercase letters, digits, "-", "_", "." (start alphanumeric), or "." for the current folder.';
  }
  return undefined;
}

/** Resolve the target dir + the package name to write into the scaffold. */
function deriveNames(rawDir: string): { dir: string; appName: string } {
  if (rawDir === "." || rawDir === "./") {
    return { dir: ".", appName: sanitizeName(basename(process.cwd())) };
  }
  return { dir: rawDir, appName: rawDir };
}

interface RawArgs {
  values: {
    yes?: boolean;
    pm?: string;
    domain?: string;
    setup?: boolean;
    "no-setup"?: boolean;
    "no-install"?: boolean;
    "no-git"?: boolean;
    skills?: boolean;
    "no-skills"?: boolean;
    "posthog-key"?: string;
    "posthog-host"?: string;
    "no-posthog"?: boolean;
    "use-tarballs"?: string;
    help?: boolean;
  };
  positionals: string[];
}

function parse(argv: string[]): RawArgs {
  // `node:util` parseArgs has no built-in `--no-x` negation, so the skip flags
  // are declared as explicit `no-install` / `no-git` / `no-setup` booleans.
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      yes: { type: "boolean", short: "y", default: false },
      pm: { type: "string" },
      domain: { type: "string" },
      setup: { type: "boolean", default: false },
      "no-setup": { type: "boolean", default: false },
      "no-install": { type: "boolean", default: false },
      "no-git": { type: "boolean", default: false },
      skills: { type: "boolean", default: false },
      "no-skills": { type: "boolean", default: false },
      "posthog-key": { type: "string" },
      "posthog-host": { type: "string" },
      "no-posthog": { type: "boolean", default: false },
      "use-tarballs": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
}

/** Abort cleanly on Ctrl-C / Esc from any clack prompt. */
function bail<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("Scaffolding cancelled — nothing was created.");
    process.exit(0);
  }
  return value as T;
}

/**
 * Resolve CLI options. Flags always win; in an interactive terminal, any value
 * not supplied by a flag is prompted for with a clack flow. In a non-interactive
 * context (CI, piped) every required value must come from flags/positionals.
 *
 * NOTE: the clack `intro()` is emitted by the caller (index.ts) before this runs,
 * so these prompts render under the same session rail.
 */
export async function resolveOptions(argv: string[]): Promise<CliOptions> {
  const { values, positionals } = parse(argv);

  if (values.help) {
    stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  // Package manager from flag (validated up front).
  let packageManager: PackageManager | undefined;
  if (values.pm !== undefined) {
    if (!isPackageManager(values.pm)) {
      throw new Error(
        `Invalid --pm "${values.pm}". Expected one of: ${VALID_PMS.join(", ")}.`,
      );
    }
    packageManager = values.pm;
  }

  // Sending domain from flag (validated up front; prompted later if absent).
  let domain = values.domain;
  if (domain !== undefined) {
    const err = validateDomain(domain);
    if (err) throw new Error(err);
    domain = domain.toLowerCase();
  }

  // PostHog from flags (validated up front; prompted later if absent).
  // --posthog-key implies "yes"; --no-posthog skips the prompt entirely.
  if (values["no-posthog"] && values["posthog-key"] !== undefined) {
    throw new Error("--no-posthog and --posthog-key are mutually exclusive.");
  }
  if (
    values["posthog-host"] !== undefined &&
    values["posthog-key"] === undefined
  ) {
    throw new Error("--posthog-host requires --posthog-key.");
  }
  let posthog: PosthogOptions | undefined;
  if (values["posthog-key"] !== undefined) {
    const keyErr = validatePosthogKey(values["posthog-key"]);
    if (keyErr) throw new Error(keyErr);
    const rawHost = values["posthog-host"] ?? POSTHOG_US_HOST;
    const hostErr = validatePosthogHost(rawHost);
    if (hostErr) throw new Error(hostErr);
    posthog = {
      apiKey: values["posthog-key"],
      host: normalizePosthogHost(rawHost),
    };
  }

  let rawDir = positionals[0];
  // `--domain mysite.com` with no app name defaults the name to "mysite".
  const defaultDirFromDomain =
    !rawDir && domain ? firstDomainLabel(domain) : undefined;
  const interactive = Boolean(stdin.isTTY);
  // Ask nothing when piped/CI (no TTY) or when the user opted into all defaults
  // with --yes. Everything then comes from flags + defaults.
  const skipPrompts = !interactive || values.yes === true;

  if (skipPrompts) {
    if (!rawDir && defaultDirFromDomain) {
      rawDir = defaultDirFromDomain;
    }
    if (!rawDir) {
      const why = values.yes
        ? 'With --yes you must pass a name (or "."). '
        : "";
      throw new Error(`Missing app name. ${why}\n${USAGE}`);
    }
    const err = validateAppName(rawDir);
    if (err) throw new Error(`Invalid app name "${rawDir}". ${err}`);
    const { dir, appName } = deriveNames(rawDir);
    const install = !values["no-install"];
    // --yes implies setup; plain CI needs an explicit --setup. Both honour
    // --no-setup, and bootstrap (runs `tsx`) is pointless without an install.
    const wantSetup = values.yes === true || values.setup === true;
    return {
      dir,
      appName,
      packageManager: packageManager ?? "pnpm",
      install,
      git: !values["no-git"],
      // Default ON; only --no-skills opts out. Mirrors `hogsend skills add`'s
      // non-TTY behaviour (install all) so CI scaffolds and CI installs agree.
      skills: !values["no-skills"],
      setup: wantSetup && !values["no-setup"] && install,
      domain,
      posthog,
      usingPosthog: posthog !== undefined,
      useTarballs: values["use-tarballs"],
    };
  }

  // Interactive: prompt for whatever a flag/positional didn't provide.
  if (rawDir) {
    const err = validateAppName(rawDir);
    if (err) throw new Error(`Invalid app name "${rawDir}". ${err}`);
  } else {
    rawDir = bail(
      await text({
        message: 'Project name? (or "." for the current folder)',
        placeholder: "acme-lifecycle",
        // --domain mysite.com pre-fills the name with "mysite".
        initialValue: defaultDirFromDomain,
        validate: validateAppName,
      }),
    );
  }
  const { dir, appName } = deriveNames(rawDir);

  // Sending domain: optional — blank means "configure later" (env.example keeps
  // its commented placeholder block).
  if (domain === undefined) {
    const answer = bail(
      await text({
        message: "Sending domain? (blank to configure later)",
        placeholder: "mysite.com",
        validate: (value) =>
          value === undefined || value === ""
            ? undefined
            : validateDomain(value),
      }),
    );
    domain = answer ? answer.toLowerCase() : undefined;
  }

  // Event sources: source-neutral AND not mutually exclusive — most teams
  // send app events and PostHog events into the same instance. The default
  // (your own app code via the pre-wired `@hogsend/client` in
  // src/lib/hogsend.ts) is pre-ticked and needs ZERO scaffold-time config:
  // bootstrap mints the ingest key. PostHog needs no key here either — the
  // post-deploy `hogsend connect posthog` OAuth flow discovers the phc_ and
  // mints the webhook secret itself, so ticking it only gates that next-step
  // hint. Selecting nothing is fine ("not sure yet" — everything can be wired
  // later). `--posthog-key` stays the escape hatch for pasting a key up front
  // (resolved above, skips this prompt); `--no-posthog` skips it too.
  let usingPosthog = posthog !== undefined;
  if (posthog === undefined && !values["no-posthog"]) {
    const sources = bail(
      await multiselect({
        message:
          "Where will events come from? (space to toggle — pick all that apply, or none)",
        initialValues: ["app"],
        required: false,
        options: [
          {
            value: "app",
            label: "My app code",
            hint: "@hogsend/client SDK, pre-wired — zero config",
          },
          {
            value: "posthog",
            label: "PostHog",
            hint: "connected at the end of setup (browser OAuth) — no key needed",
          },
        ],
      }),
    );
    usingPosthog = sources.includes("posthog");
    if (usingPosthog) {
      // The pm may not be chosen yet (this prompt comes first) — the exact,
      // copy-pasteable command is printed pm-aware in the final next-steps.
      log.info(
        `No PostHog key needed. Local setup offers a one-click connect at the end (browser OAuth) — or run \`${binCmd(packageManager ?? "pnpm", "hogsend connect posthog")}\` from your app folder any time.`,
      );
    }
  }

  if (packageManager === undefined) {
    packageManager = bail(
      await select({
        message: "Package manager?",
        initialValue: "pnpm" as PackageManager,
        options: VALID_PMS.map((pm) => ({ value: pm, label: pm })),
      }),
    );
  }

  const install = values["no-install"]
    ? false
    : bail(
        await confirm({
          message: "Install dependencies now?",
          initialValue: true,
        }),
      );

  const git = values["no-git"]
    ? false
    : bail(
        await confirm({
          message: "Initialize a git repo?",
          initialValue: true,
        }),
      );

  // --no-skills wins; explicit --skills skips the prompt; else ask (default yes).
  const skills = values["no-skills"]
    ? false
    : values.skills
      ? true
      : bail(
          await confirm({
            message:
              "Include Claude Code skills + a tailored CLAUDE.md? (recommended)",
            initialValue: true,
          }),
        );

  // Setup needs deps installed first; only offer it when we're installing.
  const setup =
    values["no-setup"] || !install
      ? false
      : values.setup
        ? true
        : bail(
            await confirm({
              message:
                "Set up local infra now? (Docker, .env, Hatchet token, migrate)",
              initialValue: true,
            }),
          );

  return {
    dir,
    appName,
    packageManager,
    install,
    git,
    skills,
    setup,
    domain,
    posthog,
    usingPosthog,
    useTarballs: values["use-tarballs"],
  };
}
