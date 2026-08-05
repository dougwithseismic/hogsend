import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stdin } from "node:process";
import { fileURLToPath } from "node:url";
import { cancel, intro, log, note, outro, spinner } from "@clack/prompts";
import color from "picocolors";
import {
  CLOUD_ENV_PULL_NOTE,
  CLOUD_HINT_NOTE,
  CLOUD_OPEN_NOTE,
  CLOUD_RESUME_INTRO,
  cloudNextCmds,
  cloudPublishCmd,
  cloudResumeCmds,
  SELF_HOST_NOTE,
} from "./cloud.js";
import { type CloudDeployResult, runCloudDeploy } from "./cloud-deploy.js";
import {
  applyAdminToEnv,
  applyDomainToEnv,
  applyOptionalPluginsToEnv,
  applyPosthogToEnv,
  copyTemplate,
  emittedTopLevelNames,
} from "./copy.js";
import { optionalPlugin } from "./optional-plugins.js";
import { binCmd, type CliOptions, resolveOptions } from "./prompts.js";
import { ENGINE_VERSION } from "./template-manifest.js";

const interactive = Boolean(stdin.isTTY);
const DOCS = "docs.hogsend.com";
const DISCORD = "discord.gg/rv6eZNvYrr";
// Studio is served by the API itself at `${API_PUBLIC_URL}/studio`. The scaffold
// defaults API_PUBLIC_URL to http://localhost:3002, so this is where the
// dashboard lives once `dev` is running. (The engine's :5173 dev banner is the
// monorepo Vite server — it does not apply to a scaffolded app.)
const STUDIO_LOCAL_URL = "http://localhost:3002/studio";

function templateDir(): string {
  // `dist/index.js` and `template/` are siblings in the published tarball
  // (package.json `files: ["dist","template"]`).
  return fileURLToPath(new URL("../template", import.meta.url));
}

/**
 * The RUNNING create-hogsend version, read from our own package.json (sibling
 * of dist/ in the published tarball). Shown in the banner because "which
 * version am I actually running?" is the first question when a scaffold
 * misbehaves — pnpm 11's release-age quarantine once silently served a
 * stale create-hogsend under `@latest`, and nothing on screen said so.
 * Falls back to the pinned engine line if the read ever fails.
 */
function cliVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../package.json", import.meta.url)),
        "utf8",
      ),
    ) as { version?: string };
    return pkg.version ?? ENGINE_VERSION;
  } catch {
    return ENGINE_VERSION;
  }
}

function isCurrentDir(opts: CliOptions): boolean {
  return opts.dir === "." || opts.dir === "./";
}

/** Idiomatic "run a script" per pm — only npm needs the explicit `run` word. */
function scriptCmd(pm: CliOptions["packageManager"], script: string): string {
  return pm === "npm" ? `npm run ${script}` : `${pm} ${script}`;
}

/** Idiomatic "run a published bin without installing it" per pm. */
function dlxCmd(pm: CliOptions["packageManager"], bin: string): string {
  switch (pm) {
    case "npm":
      return `npx ${bin}`;
    case "yarn":
      return `yarn dlx ${bin}`;
    case "bun":
      return `bunx ${bin}`;
    default:
      return `pnpm dlx ${bin}`;
  }
}

async function isNonEmptyDir(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return false;
  const entries = await readdir(dir);
  return entries.length > 0;
}

/**
 * Guard the target before writing. A named dir must not already exist with
 * content; the current dir (`.`) may contain unrelated files, but we refuse to
 * clobber anything the scaffold would emit.
 */
async function assertWritable(
  opts: CliOptions,
  targetDir: string,
): Promise<void> {
  if (!isCurrentDir(opts)) {
    if (await isNonEmptyDir(targetDir)) {
      throw new Error(
        `Target directory "${targetDir}" exists and is not empty.`,
      );
    }
    return;
  }
  const names = (await emittedTopLevelNames(templateDir())).filter(
    // Not emitted under --no-skills, so they can't collide.
    (n) => opts.skills || (n !== ".claude" && n !== "CLAUDE.md"),
  );
  const collisions = names.filter((n) => existsSync(join(targetDir, n)));
  if (collisions.length > 0) {
    throw new Error(
      `Current folder already has files the scaffold would overwrite: ${collisions.join(", ")}.\n` +
        "Run in an empty folder, or remove those files first.",
    );
  }
}

/**
 * Run a child process to completion WITHOUT blocking the event loop. This is the
 * whole reason install/git use the async `spawn` and not `spawnSync`: a clack
 * spinner animates on a `setInterval`, and `spawnSync` blocks the loop for the
 * entire (often 30s+) install — freezing the spinner on one frame, which reads
 * as "is this stuck?". `spawn` keeps the loop free so the spinner actually spins.
 * Resolves the exit code (1 on spawn error).
 */
function runAsync(
  cmd: string,
  args: string[],
  stdio: "ignore" | "inherit",
  targetDir: string,
): Promise<number> {
  return new Promise((res) => {
    const child = spawn(cmd, args, {
      cwd: targetDir,
      stdio,
      // pnpm/npm/yarn/bun are .cmd shims on Windows — they need a shell.
      shell: process.platform === "win32",
    });
    child.on("error", () => res(1));
    child.on("close", (code) => res(code ?? 1));
  });
}

async function tryGitInit(targetDir: string): Promise<boolean> {
  const run = (args: string[]) => runAsync("git", args, "ignore", targetDir);
  try {
    if ((await run(["init"])) !== 0) return false;
    await run(["add", "-A"]);
    await run(["commit", "-m", "chore: scaffold hogsend app"]);
    return true;
  } catch {
    // git missing or commit failed — scaffold is still valid, never fatal.
    return false;
  }
}

async function runInstall(
  targetDir: string,
  pm: CliOptions["packageManager"],
): Promise<boolean> {
  // Interactive: swallow output so it doesn't fight the spinner (which now stays
  // alive because the install runs async). Non-interactive: stream it so CI logs
  // show the install.
  const code = await runAsync(
    pm,
    ["install"],
    interactive ? "ignore" : "inherit",
    targetDir,
  );
  return code === 0;
}

/** Stream `<pm> run bootstrap` — it prints its own step-by-step progress. */
function runBootstrap(
  targetDir: string,
  pm: CliOptions["packageManager"],
  usingPosthog: boolean,
): boolean {
  const result = spawnSync(pm, ["run", "bootstrap"], {
    cwd: targetDir,
    stdio: "inherit",
    shell: process.platform === "win32",
    // Tells bootstrap the user picked PostHog at scaffold time, so it offers
    // the "one last thing — connect PostHog now?" step (default yes). Plain
    // re-runs of bootstrap don't see this and stay quiet.
    env: {
      ...process.env,
      ...(usingPosthog ? { HOGSEND_SETUP_POSTHOG: "1" } : {}),
    },
  });
  return result.status === 0;
}

/**
 * Post-deploy PostHog hint — shown only when PostHog is in use. The command is
 * pm-aware (`pnpm hogsend …` / `npx hogsend …`) because the CLI ships with the
 * app's deps, not on the PATH; `withCd` prefixes `cd <app> && ` for contexts
 * where the hint stands alone (after bootstrap already ran), so it stays
 * copy-pasteable from the scaffold's parent directory. Inside the next-steps
 * block (which opens with `cd <app>`) the bare command is used.
 */
function posthogNextStep(opts: CliOptions, withCd: boolean): string {
  const cd = withCd && !isCurrentDir(opts) ? `cd ${opts.dir} && ` : "";
  return `${cd}${binCmd(opts.packageManager, "hogsend connect posthog")}`;
}
const POSTHOG_HINT_NOTE =
  "  # after deploy: authorize PostHog, mint the webhook secret, wire the event loop";
/** The colored form of the hint — command cyan, note dim. */
function posthogHint(opts: CliOptions, withCd: boolean): string {
  return `${color.cyan(posthogNextStep(opts, withCd))}${color.dim(POSTHOG_HINT_NOTE)}`;
}

/**
 * The two lines that say hosting exists. Printed in EVERY outro mode — a
 * headless scaffold must not learn fewer facts than an interactive one.
 */
function cloudLines(opts: CliOptions): string[] {
  return [
    `${color.cyan(cloudPublishCmd(opts.packageManager))}   ${color.dim(CLOUD_HINT_NOTE)}`,
    color.dim(SELF_HOST_NOTE),
  ];
}

/**
 * What to print INSTEAD of the hosting hint once the app is actually live.
 *
 * The hint exists to tell somebody Cloud is an option; to a person whose app is
 * already running there it would be noise at best and confusing at worst.
 */
function cloudSuccessLines(opts: CliOptions): string[] {
  const [open, envPull] = cloudNextCmds(opts.packageManager);
  return [
    `${color.cyan(open ?? "")}   ${color.dim(CLOUD_OPEN_NOTE)}`,
    `${color.cyan(envPull ?? "")}   ${color.dim(CLOUD_ENV_PULL_NOTE)}`,
  ];
}

/** And what to print when the handoff did not finish: how to pick it back up. */
function cloudResumeLines(opts: CliOptions): string[] {
  if (!opts.cloud) return [];
  return [
    color.dim(CLOUD_RESUME_INTRO),
    ...cloudResumeCmds(opts.packageManager, {
      email: opts.cloud.email,
      ...(opts.cloud.cloudUrl === undefined
        ? {}
        : { cloudUrl: opts.cloud.cloudUrl }),
    }).map((cmd) => color.cyan(`  ${cmd}`)),
  ];
}

/** A dim, fixed-width label so the link rows line up under each other. */
function linkRow(label: string, url: string, note: string): string {
  return `${color.dim(label.padEnd(8))}${color.cyan(url)}   ${color.dim(note)}`;
}

/** The guided "what now" — the difference between a scaffold and an onboarding. */
/**
 * The hosting block, in its three shapes: the hint (nobody asked for cloud),
 * the live-instance next steps (it worked), or the resume commands (it did
 * not). Exactly one of them is ever printed.
 */
function hostingLines(
  opts: CliOptions,
  cloudResult: CloudDeployResult | null,
): string[] {
  if (cloudResult === null) return cloudLines(opts);
  return cloudResult.ok ? cloudSuccessLines(opts) : cloudResumeLines(opts);
}

function nextSteps(
  opts: CliOptions,
  setupDone: boolean,
  cloudResult: CloudDeployResult | null,
): string {
  const pm = opts.packageManager;
  const cd = isCurrentDir(opts) ? null : color.cyan(`cd ${opts.dir}`);
  const skillsLine = opts.skills
    ? `${color.dim("Agent skills:")} ${color.cyan(".claude/skills")}   ${color.dim("· Claude Code discovers them automatically")}`
    : `${color.dim("Add agent skills later:")} ${color.cyan(dlxCmd(pm, "hogsend skills add"))}`;

  // Run-it: the one command that actually starts the app (it does NOT run
  // after bootstrap — bootstrap only brings up the infra it depends on).
  // `hogsend dev` is the daily driver: API + worker + health + URLs, one
  // terminal (the manual `dev` + `worker:dev` pair is in the README).
  // Run it here, hand it to Hogsend Cloud, or self-host it — three paths, same
  // repo. Hosting is a later decision with no migration, so this is copy, not
  // a fork in the flow.
  const run = [
    `${color.cyan(binCmd(pm, "hogsend dev"))}   ${color.dim("# API + worker + Studio on :3002, one terminal")}`,
    ...hostingLines(opts, cloudResult),
  ];

  // Where to go next — the three touchpoints the onboarding hinges on.
  const links = [
    "",
    linkRow(
      "Studio",
      STUDIO_LOCAL_URL,
      `# dashboard — open it after ${binCmd(pm, "hogsend dev")}`,
    ),
    linkRow(
      "Docs",
      DOCS,
      "# guides + your first journey: src/journeys/welcome.ts",
    ),
    linkRow("Discord", DISCORD, "# questions, help, and what we're shipping"),
  ];

  const tail = [
    ...run,
    ...links,
    "",
    skillsLine,
    opts.usingPosthog ? posthogHint(opts, false) : null,
  ];

  const lines = setupDone
    ? [cd, ...tail]
    : [
        cd,
        opts.install ? null : color.cyan(`${pm} install`),
        `${color.cyan(scriptCmd(pm, "bootstrap"))}   ${color.dim("# Docker infra + .env + Hatchet token + migrate")}`,
        ...tail,
      ];

  return lines.filter((l): l is string => l !== null).join("\n");
}

async function main(): Promise<void> {
  const version = cliVersion();
  if (interactive) {
    intro(
      `${color.bgMagenta(color.black(" create-hogsend "))} ${color.dim(`v${version} · scaffold a Hogsend app · ${DOCS}`)}`,
    );
    note(
      `${color.dim(
        "Lifecycle marketing for scrappy product engineering teams —\ncode-first journeys on PostHog + Resend.",
      )}\n${color.dim("Docs & guides: ")}${color.cyan("hogsend.com")}`,
      color.magenta("Welcome to Hogsend"),
    );
  }

  if (!interactive) {
    // Headless runs get the version too — it's the first fact a CI log or an
    // agent transcript needs when a scaffold misbehaves.
    console.log(`create-hogsend v${version} (engine line ^${ENGINE_VERSION})`);
  }

  const opts = await resolveOptions(process.argv.slice(2));
  const targetDir = resolve(process.cwd(), opts.dir);
  const label = isCurrentDir(opts)
    ? `${opts.appName} ${color.dim("(current folder)")}`
    : opts.dir;

  await assertWritable(opts, targetDir);

  const tarballDir = opts.useTarballs
    ? resolve(process.cwd(), opts.useTarballs)
    : undefined;

  if (interactive) {
    const s = spinner();
    s.start(`Scaffolding ${opts.appName}`);
    await copyTemplate({
      templateDir: templateDir(),
      targetDir,
      appName: opts.appName,
      packageManager: opts.packageManager,
      skills: opts.skills,
      optionalPlugins: opts.withPlugins,
      tarballDir,
    });
    s.stop(`${color.green("✓")} Scaffolded ${color.cyan(label)}`);
  } else {
    console.log(`\n  Scaffolding ${opts.appName} ...`);
    await copyTemplate({
      templateDir: templateDir(),
      targetDir,
      appName: opts.appName,
      packageManager: opts.packageManager,
      skills: opts.skills,
      optionalPlugins: opts.withPlugins,
      tarballDir,
    });
  }

  // Opt-in provider plugins: dependency pinning happened during copyTemplate;
  // here we surface each credential block in .env.example. Same timing as the
  // domain patch below — before install/bootstrap, so bootstrap's .env copy
  // inherits the blocks.
  if (opts.withPlugins.length > 0) {
    await applyOptionalPluginsToEnv(targetDir, opts.withPlugins);
    if (interactive) {
      const pkgs = opts.withPlugins
        .map((id) => optionalPlugin(id).pkg)
        .join(", ");
      log.step(
        `${color.dim("Optional providers —")} ${pkgs} ${color.dim("pinned as dependencies; set the credential(s) in .env to activate")}`,
      );
    }
  }

  // Patch env.example BEFORE install/bootstrap so the bootstrap-copied .env
  // inherits the sending-domain values.
  if (opts.domain) {
    await applyDomainToEnv(targetDir, opts.domain);
    if (interactive) {
      log.step(
        `${color.dim("Sending domain —")} EMAIL_FROM=hello@${opts.domain} ${color.dim("+")} EMAIL_DOMAIN=${opts.domain}`,
      );
    }
  }

  // Same timing as the domain patch: the bootstrap-copied .env inherits the
  // PostHog values + the minted webhook secret.
  if (opts.posthog) {
    await applyPosthogToEnv(targetDir, opts.posthog);
    if (interactive) {
      log.step(
        `${color.dim("PostHog —")} POSTHOG_HOST=${opts.posthog.host} ${color.dim("+ ENABLE_POSTHOG_DESTINATION=true + minted POSTHOG_WEBHOOK_SECRET")}`,
      );
    }
  }

  // First Studio admin preset (--admin-email / --admin-password): written into
  // .env.example before install/bootstrap so bootstrap's .env inherits it and
  // the API mints the admin on first boot. The password is NEVER echoed.
  if (opts.adminEmail) {
    await applyAdminToEnv(targetDir, {
      email: opts.adminEmail,
      password: opts.adminPassword,
    });
    if (interactive) {
      log.step(
        `${color.dim("Studio admin —")} STUDIO_ADMIN_EMAIL=${opts.adminEmail} ${color.dim(
          opts.adminPassword
            ? "+ STUDIO_ADMIN_PASSWORD (hidden) — minted on first boot"
            : "— password generated + printed once on first boot",
        )}`,
      );
    }
  }

  if (opts.git) {
    if (interactive) {
      const s = spinner();
      s.start("Initializing git repo");
      const ok = await tryGitInit(targetDir);
      s.stop(
        ok
          ? `${color.green("✓")} Git repo initialized`
          : `${color.yellow("!")} Skipped git (not available)`,
      );
    } else {
      await tryGitInit(targetDir);
    }
  }

  // Tracked so we never run bootstrap (which needs `tsx`) without a good install.
  let installed = false;
  if (opts.install) {
    if (interactive) {
      const s = spinner();
      s.start(`Installing dependencies (${opts.packageManager} install)`);
      installed = await runInstall(targetDir, opts.packageManager);
      s.stop(
        installed
          ? `${color.green("✓")} Dependencies installed`
          : `${color.yellow("!")} Install didn't finish — run it manually`,
      );
    } else {
      installed = await runInstall(targetDir, opts.packageManager);
      if (!installed) {
        console.warn(
          `\n  "${opts.packageManager} install" did not complete. Run it manually in the app dir.`,
        );
      }
    }
  }

  let setupDone = false;
  if (opts.setup && installed) {
    const bootstrapCmd = scriptCmd(opts.packageManager, "bootstrap");
    if (interactive) {
      log.step(`${color.dim("Running local setup —")} ${bootstrapCmd}`);
    } else {
      console.log("\n  Running local setup ...\n");
    }
    setupDone = runBootstrap(targetDir, opts.packageManager, opts.usingPosthog);
    if (!setupDone && interactive) {
      log.warn(
        `${color.yellow("Setup didn't finish.")} Fix the issue above, then run ${color.cyan(bootstrapCmd)} again.`,
      );
    }
  }

  // The cloud handoff (PRD 17). LAST, after everything that makes the app
  // real, and only when it was explicitly asked for.
  //
  // The rules, in the order they matter:
  //  - it needs an install: the CLI it drives is one of the app's own
  //    dependencies, so without one there is nothing to drive;
  //  - it NEVER throws. A failed deploy is a verdict the outro renders, not an
  //    exception that skips the "here is your app" summary;
  //  - and the scaffold on disk is complete either way. Whatever the control
  //    plane did, the app is locally usable, which is why this runs after the
  //    scaffold rather than as part of it.
  let cloudResult: CloudDeployResult | null = null;
  if (opts.cloud) {
    if (!installed) {
      cloudResult = {
        ok: false,
        step: "resolve-cli",
        message:
          "Dependencies were not installed, so the app's `hogsend` CLI was not there to deploy with.",
      };
    } else {
      if (interactive) {
        log.step(
          `${color.dim("Deploying to Hogsend Cloud —")} ${opts.cloud.email}`,
        );
      } else {
        console.log("\n  Deploying to Hogsend Cloud ...\n");
      }
      cloudResult = runCloudDeploy({
        targetDir,
        appName: opts.appName,
        cloud: opts.cloud,
      });
      if (!cloudResult.ok && interactive) {
        log.warn(`${color.yellow(cloudResult.message)}`);
      } else if (!cloudResult.ok) {
        console.warn(`\n  ${cloudResult.message}\n`);
      }
    }
  }

  // When setup ran, bootstrap already printed the "✓ Ready / Next:" summary —
  // don't repeat the stack/next-steps block, just close out briefly (keeping
  // the `cd` hint, which bootstrap can't know about).
  const cdHint = isCurrentDir(opts) ? "" : `cd ${opts.dir} · `;
  if (interactive) {
    if (!setupDone) note(nextSteps(opts, setupDone, cloudResult), "Next steps");
    // Bootstrap's own summary can't know about PostHog or about hosting —
    // surface both here when the next-steps note was skipped, so a scaffold
    // that ran setup learns the same facts as one that didn't.
    if (setupDone) log.info(hostingLines(opts, cloudResult).join("\n"));
    if (setupDone && opts.usingPosthog) log.info(posthogHint(opts, true));
    outro(
      `${color.magenta("Welcome to Hogsend.")} ${color.dim(`${cdHint}${DOCS} · ${DISCORD}`)}`,
    );
  } else {
    const pm = opts.packageManager;
    const cd = isCurrentDir(opts) ? "" : `    cd ${opts.dir}\n`;
    const dev = binCmd(pm, "hogsend dev");
    const skillsNote = opts.skills
      ? "  Agent skills: .claude/skills (Claude Code discovers them automatically)"
      : `  Add agent skills later: ${dlxCmd(pm, "hogsend skills add")}`;
    // Same two facts as the interactive outro, in the plain-text shape this
    // block uses. Present in BOTH branches below — an agent-driven scaffold
    // that also ran setup must still be told hosting exists.
    // The same three shapes as the interactive outro (hint / live / resume),
    // in the plain-text form this block uses. One string, interpolated into
    // BOTH branches below — an agent-driven scaffold that also ran setup must
    // still be told what happened to its deploy.
    const cloudNote =
      cloudResult === null
        ? `    ${cloudPublishCmd(pm)}   ${CLOUD_HINT_NOTE}\n` +
          `    ${SELF_HOST_NOTE}`
        : cloudResult.ok
          ? cloudNextCmds(pm)
              .map(
                (cmd, at) =>
                  `    ${cmd}   ${at === 0 ? CLOUD_OPEN_NOTE : CLOUD_ENV_PULL_NOTE}`,
              )
              .join("\n")
          : [
              `  ${CLOUD_RESUME_INTRO}`,
              ...cloudResumeCmds(pm, {
                email: opts.cloud?.email ?? "",
                ...(opts.cloud?.cloudUrl === undefined
                  ? {}
                  : { cloudUrl: opts.cloud.cloudUrl }),
              }).map((cmd) => `    ${cmd}`),
            ].join("\n");
    const posthogNote = opts.usingPosthog
      ? `\n  ${posthogNextStep(opts, setupDone)}${POSTHOG_HINT_NOTE}`
      : "";
    const links =
      `  Studio    ${STUDIO_LOCAL_URL}   # dashboard (after ${dev})\n` +
      `  Docs      ${DOCS}   # first journey: src/journeys/welcome.ts\n` +
      `  Discord   ${DISCORD}   # questions, help, and what we're shipping`;
    if (setupDone) {
      // Bootstrap already streamed its full "Ready" summary — just add the
      // welcome + the `cd` hint it can't know about.
      console.log(`
  Welcome to Hogsend. ${cdHint}Docs: ${DOCS} · Discord: ${DISCORD}

${cloudNote}${posthogNote}
`);
    } else {
      console.log(`
  Welcome to Hogsend. Next steps:

${cd}${opts.install ? "" : `    ${pm} install\n`}    ${scriptCmd(pm, "bootstrap")}     # Docker infra + .env + Hatchet token + migrate
    ${dev}   # API + worker + Studio on :3002, one terminal
${cloudNote}

${links}
${skillsNote}${posthogNote}
`);
    }
  }

  applyCloudExitCode(cloudResult);
}

/**
 * EXIT CODE, stated once because it is a real decision:
 *
 * a scaffold whose `--cloud` handoff failed exits NONZERO, even though the app
 * on disk is complete and usable. `--cloud` is an explicit request to end up
 * with a running instance, and a caller that asked for one — a CI job, an agent
 * — must be able to tell that it did not get one. The resume commands are
 * printed either way, so a human loses nothing.
 *
 * This deliberately differs from a failed `bootstrap`, which exits 0: that step
 * is local, recoverable on the spot, and its failure is already loud on the
 * screen of the person standing there. If we ever want the two to agree, the
 * bootstrap one should move to nonzero — not this one back to zero.
 *
 * `process.exitCode` rather than `process.exit()`, so the outro above is
 * actually flushed before the process ends.
 */
function applyCloudExitCode(result: CloudDeployResult | null): void {
  if (result && !result.ok) process.exitCode = 1;
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  if (interactive) cancel(msg);
  else console.error(`\n  ${msg}\n`);
  // Non-interactive runs are agent-driven: pass the full cause back (a
  // terminal gets it on demand via HOGSEND_DEBUG=1).
  const stack = err instanceof Error ? err.stack : undefined;
  if (stack && (!interactive || process.env.HOGSEND_DEBUG === "1")) {
    console.error(stack);
  }
  process.exit(1);
});
