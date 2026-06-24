import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stdin } from "node:process";
import { fileURLToPath } from "node:url";
import { cancel, intro, log, note, outro, spinner } from "@clack/prompts";
import color from "picocolors";
import {
  applyDomainToEnv,
  applyPosthogToEnv,
  copyTemplate,
  emittedTopLevelNames,
} from "./copy.js";
import { type CliOptions, resolveOptions } from "./prompts.js";

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
): boolean {
  const result = spawnSync(pm, ["run", "bootstrap"], {
    cwd: targetDir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return result.status === 0;
}

/** Post-deploy PostHog hint — shown only when PostHog is in use. */
const POSTHOG_NEXT_STEP = `${color.cyan("hogsend connect posthog")}${color.dim("  # after deploy: authorize PostHog, mint the webhook secret, wire the event loop")}`;
const POSTHOG_NEXT_STEP_PLAIN =
  "hogsend connect posthog  # after deploy: authorize PostHog, mint the webhook secret, wire the event loop";

/** A dim, fixed-width label so the link rows line up under each other. */
function linkRow(label: string, url: string, note: string): string {
  return `${color.dim(label.padEnd(8))}${color.cyan(url)}   ${color.dim(note)}`;
}

/** The guided "what now" — the difference between a scaffold and an onboarding. */
function nextSteps(opts: CliOptions, setupDone: boolean): string {
  const pm = opts.packageManager;
  const cd = isCurrentDir(opts) ? null : color.cyan(`cd ${opts.dir}`);
  const skillsLine = opts.skills
    ? `${color.dim("Agent skills:")} ${color.cyan(".claude/skills")}   ${color.dim("· Claude Code discovers them automatically")}`
    : `${color.dim("Add agent skills later:")} ${color.cyan(dlxCmd(pm, "hogsend skills add"))}`;

  // Run-it: the two commands that actually start the app (it does NOT run after
  // bootstrap — bootstrap only brings up the infra it depends on).
  const run = [
    `${color.cyan(scriptCmd(pm, "dev"))}   ${color.dim("# API + Studio on :3002")}`,
    `${color.cyan(scriptCmd(pm, "worker:dev"))}   ${color.dim("# Hatchet worker, 2nd terminal — runs your journeys")}`,
  ];

  // Where to go next — the three touchpoints the onboarding hinges on.
  const links = [
    "",
    linkRow(
      "Studio",
      STUDIO_LOCAL_URL,
      `# dashboard — open it after ${scriptCmd(pm, "dev")}`,
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
    opts.usingPosthog ? POSTHOG_NEXT_STEP : null,
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
  if (interactive) {
    intro(
      `${color.bgMagenta(color.black(" create-hogsend "))} ${color.dim(`scaffold a Hogsend app · ${DOCS}`)}`,
    );
    note(
      `${color.dim(
        "Lifecycle marketing for scrappy product engineering teams —\ncode-first journeys on PostHog + Resend.",
      )}\n${color.dim("Docs & guides: ")}${color.cyan("hogsend.com")}`,
      color.magenta("Welcome to Hogsend"),
    );
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
      skills: opts.skills,
      tarballDir,
    });
    s.stop(`${color.green("✓")} Scaffolded ${color.cyan(label)}`);
  } else {
    console.log(`\n  Scaffolding ${opts.appName} ...`);
    await copyTemplate({
      templateDir: templateDir(),
      targetDir,
      appName: opts.appName,
      skills: opts.skills,
      tarballDir,
    });
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
    setupDone = runBootstrap(targetDir, opts.packageManager);
    if (!setupDone && interactive) {
      log.warn(
        `${color.yellow("Setup didn't finish.")} Fix the issue above, then run ${color.cyan(bootstrapCmd)} again.`,
      );
    }
  }

  // When setup ran, bootstrap already printed the "✓ Ready / Next:" summary —
  // don't repeat the stack/next-steps block, just close out briefly (keeping
  // the `cd` hint, which bootstrap can't know about).
  const cdHint = isCurrentDir(opts) ? "" : `cd ${opts.dir} · `;
  if (interactive) {
    if (!setupDone) note(nextSteps(opts, setupDone), "Next steps");
    // Bootstrap's own summary can't know about PostHog — surface the connect
    // hint here when the next-steps note was skipped.
    if (setupDone && opts.usingPosthog) log.info(POSTHOG_NEXT_STEP);
    outro(
      `${color.magenta("Welcome to Hogsend.")} ${color.dim(`${cdHint}${DOCS} · ${DISCORD}`)}`,
    );
  } else {
    const pm = opts.packageManager;
    const cd = isCurrentDir(opts) ? "" : `    cd ${opts.dir}\n`;
    const dev = scriptCmd(pm, "dev");
    const worker = scriptCmd(pm, "worker:dev");
    const skillsNote = opts.skills
      ? "  Agent skills: .claude/skills (Claude Code discovers them automatically)"
      : `  Add agent skills later: ${dlxCmd(pm, "hogsend skills add")}`;
    const posthogNote = opts.usingPosthog
      ? `\n  ${POSTHOG_NEXT_STEP_PLAIN}`
      : "";
    const links =
      `  Studio    ${STUDIO_LOCAL_URL}   # dashboard (after ${dev})\n` +
      `  Docs      ${DOCS}   # first journey: src/journeys/welcome.ts\n` +
      `  Discord   ${DISCORD}   # questions, help, and what we're shipping`;
    if (setupDone) {
      // Bootstrap already streamed its full "Ready" summary — just add the
      // welcome + the `cd` hint it can't know about.
      console.log(`
  Welcome to Hogsend. ${cdHint}Docs: ${DOCS} · Discord: ${DISCORD}${posthogNote}
`);
    } else {
      console.log(`
  Welcome to Hogsend. Next steps:

${cd}${opts.install ? "" : `    ${pm} install\n`}    ${scriptCmd(pm, "bootstrap")}     # Docker infra + .env + Hatchet token + migrate
    ${dev}           # API + Studio on :3002
    ${worker}    # Hatchet worker (second terminal)

${links}
${skillsNote}${posthogNote}
`);
    }
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  if (interactive) cancel(msg);
  else console.error(`\n  ${msg}\n`);
  process.exit(1);
});
