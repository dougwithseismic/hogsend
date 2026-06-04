import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stdin } from "node:process";
import { fileURLToPath } from "node:url";
import { cancel, intro, log, note, outro, spinner } from "@clack/prompts";
import color from "picocolors";
import { copyTemplate, emittedTopLevelNames } from "./copy.js";
import { type CliOptions, resolveOptions } from "./prompts.js";

const interactive = Boolean(stdin.isTTY);
const DOCS = "docs.hogsend.com";

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
  const names = await emittedTopLevelNames(templateDir());
  const collisions = names.filter((n) => existsSync(join(targetDir, n)));
  if (collisions.length > 0) {
    throw new Error(
      `Current folder already has files the scaffold would overwrite: ${collisions.join(", ")}.\n` +
        "Run in an empty folder, or remove those files first.",
    );
  }
}

function tryGitInit(targetDir: string): boolean {
  const run = (args: string[]) =>
    spawnSync("git", args, { cwd: targetDir, stdio: "ignore" });
  try {
    if (run(["init"]).status !== 0) return false;
    run(["add", "-A"]);
    run(["commit", "-m", "chore: scaffold hogsend app"]);
    return true;
  } catch {
    // git missing or commit failed — scaffold is still valid, never fatal.
    return false;
  }
}

function runInstall(
  targetDir: string,
  pm: CliOptions["packageManager"],
): boolean {
  // Interactive: capture output so it doesn't fight the spinner; we only surface
  // it on failure. Non-interactive: stream it so CI logs show the install.
  const result = spawnSync(pm, ["install"], {
    cwd: targetDir,
    stdio: interactive ? "ignore" : "inherit",
  });
  return result.status === 0;
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

/** The guided "what now" — the difference between a scaffold and an onboarding. */
function nextSteps(opts: CliOptions, setupDone: boolean): string {
  const pm = opts.packageManager;
  const cd = isCurrentDir(opts) ? null : color.cyan(`cd ${opts.dir}`);
  const tail = [
    `${color.cyan(scriptCmd(pm, "dev"))}   ${color.dim("# API on :3002")}`,
    `${color.cyan(scriptCmd(pm, "worker:dev"))}   ${color.dim("# Hatchet worker, 2nd terminal")}`,
    "",
    `${color.dim("First journey:")} ${color.cyan("src/journeys/welcome.ts")}   ${color.dim(`· ${DOCS}`)}`,
  ];

  const lines = setupDone
    ? [cd, ...tail]
    : [
        cd,
        opts.install ? null : color.cyan(`${pm} install`),
        `${color.cyan(scriptCmd(pm, "bootstrap"))}   ${color.dim("# Docker + .env + Hatchet token + migrate")}`,
        ...tail,
      ];

  return lines.filter((l): l is string => l !== null).join("\n");
}

async function main(): Promise<void> {
  if (interactive) {
    intro(
      `${color.bgMagenta(color.black(" create-hogsend "))} ${color.dim(`scaffold a Hogsend app · ${DOCS}`)}`,
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
      tarballDir,
    });
    s.stop(`${color.green("✓")} Scaffolded ${color.cyan(label)}`);
  } else {
    console.log(`\n  Scaffolding ${opts.appName} ...`);
    await copyTemplate({
      templateDir: templateDir(),
      targetDir,
      appName: opts.appName,
      tarballDir,
    });
  }

  if (opts.git) {
    if (interactive) {
      const s = spinner();
      s.start("Initializing git repo");
      const ok = tryGitInit(targetDir);
      s.stop(
        ok
          ? `${color.green("✓")} Git repo initialized`
          : `${color.yellow("!")} Skipped git (not available)`,
      );
    } else {
      tryGitInit(targetDir);
    }
  }

  // Tracked so we never run bootstrap (which needs `tsx`) without a good install.
  let installed = false;
  if (opts.install) {
    if (interactive) {
      const s = spinner();
      s.start(`Installing dependencies (${opts.packageManager} install)`);
      installed = runInstall(targetDir, opts.packageManager);
      s.stop(
        installed
          ? `${color.green("✓")} Dependencies installed`
          : `${color.yellow("!")} Install didn't finish — run it manually`,
      );
    } else {
      installed = runInstall(targetDir, opts.packageManager);
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

  if (interactive) {
    if (!setupDone) note(nextSteps(opts, setupDone), "Next steps");
    outro(
      setupDone
        ? `${color.green("Done.")} ${color.dim("Stack is up — go write a journey.")}`
        : `${color.green("Scaffolded.")} ${color.dim(`Run the steps above. Docs: ${DOCS}`)}`,
    );
  } else {
    const pm = opts.packageManager;
    const cd = isCurrentDir(opts) ? "" : `    cd ${opts.dir}\n`;
    const dev = scriptCmd(pm, "dev");
    const worker = scriptCmd(pm, "worker:dev");
    if (setupDone) {
      console.log(`
  Done. Stack is up. Next:

${cd}    ${dev}          # HTTP API (port 3002)
    ${worker}   # Hatchet worker (second terminal)

  First journey: src/journeys/welcome.ts — docs at ${DOCS}
`);
    } else {
      console.log(`
  Done. Next steps:

${cd}${opts.install ? "" : `    ${pm} install\n`}    ${scriptCmd(pm, "bootstrap")}     # Docker + .env + Hatchet token + migrate
    ${dev}           # HTTP API (port 3002)
    ${worker}    # Hatchet worker (second terminal)

  First journey: src/journeys/welcome.ts — docs at ${DOCS}
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
