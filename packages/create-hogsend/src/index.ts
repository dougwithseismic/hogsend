import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { stdin } from "node:process";
import { fileURLToPath } from "node:url";
import { cancel, intro, note, outro, spinner } from "@clack/prompts";
import color from "picocolors";
import { copyTemplate } from "./copy.js";
import { type CliOptions, resolveOptions } from "./prompts.js";

const interactive = Boolean(stdin.isTTY);

function templateDir(): string {
  // `dist/index.js` and `template/` are siblings in the published tarball
  // (package.json `files: ["dist","template"]`).
  return fileURLToPath(new URL("../template", import.meta.url));
}

async function isNonEmptyDir(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return false;
  const entries = await readdir(dir);
  return entries.length > 0;
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

/** The guided "what now" — the difference between a scaffold and an onboarding. */
function nextSteps(opts: CliOptions): string {
  const pm = opts.packageManager;
  return [
    color.cyan(`cd ${opts.appName}`),
    opts.install ? null : color.cyan(`${pm} install`),
    `${color.cyan("docker compose up -d")}   ${color.dim("# Postgres + Redis + Hatchet-Lite")}`,
    `${color.cyan("cp .env.example .env")}   ${color.dim("# set RESEND_API_KEY +")}`,
    `${color.dim("                         # HATCHET_CLIENT_TOKEN (grab it at http://localhost:8888)")}`,
    color.cyan(`${pm} db:migrate`),
    `${color.cyan(`${pm} dev`)}   ${color.dim("# API on :3002")}`,
    `${color.cyan(`${pm} worker:dev`)}   ${color.dim("# Hatchet worker, 2nd terminal")}`,
    "",
    `${color.dim("Then open")} ${color.cyan("src/journeys/welcome.ts")} ${color.dim("— your first journey.")}`,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
}

async function main(): Promise<void> {
  if (interactive) {
    intro(
      `${color.bgMagenta(color.black(" create-hogsend "))} ${color.dim("scaffold a Hogsend app")}`,
    );
  }

  const opts = await resolveOptions(process.argv.slice(2));
  const targetDir = resolve(process.cwd(), opts.appName);

  if (await isNonEmptyDir(targetDir)) {
    throw new Error(`Target directory "${targetDir}" exists and is not empty.`);
  }

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
    s.stop(`${color.green("✓")} Scaffolded ${color.cyan(opts.appName)}`);
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

  if (opts.install) {
    if (interactive) {
      const s = spinner();
      s.start(`Installing dependencies (${opts.packageManager} install)`);
      const ok = runInstall(targetDir, opts.packageManager);
      s.stop(
        ok
          ? `${color.green("✓")} Dependencies installed`
          : `${color.yellow("!")} Install didn't finish — run it manually`,
      );
    } else if (!runInstall(targetDir, opts.packageManager)) {
      console.warn(
        `\n  "${opts.packageManager} install" did not complete. Run it manually in the app dir.`,
      );
    }
  }

  if (interactive) {
    note(nextSteps(opts), "Next steps");
    outro(
      `${color.green("Done.")} ${color.dim("You're set — go write a journey.")}`,
    );
  } else {
    const pm = opts.packageManager;
    console.log(`
  Done. Next steps:

    cd ${opts.appName}${opts.install ? "" : `\n    ${pm} install`}
    docker compose up -d        # Postgres + Redis + Hatchet-Lite
    cp .env.example .env        # set RESEND_API_KEY + HATCHET_CLIENT_TOKEN (from http://localhost:8888)
    ${pm} db:migrate            # engine track then client track
    ${pm} dev                   # HTTP API (port 3002)
    ${pm} worker:dev            # Hatchet worker (second terminal)

  Then edit src/journeys/welcome.ts — see README.md
`);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  if (interactive) cancel(msg);
  else console.error(`\n  ${msg}\n`);
  process.exit(1);
});
