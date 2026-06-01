import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyTemplate } from "./copy.js";
import { type CliOptions, resolveOptions } from "./prompts.js";

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

function tryGitInit(targetDir: string): void {
  const run = (args: string[]) =>
    spawnSync("git", args, { cwd: targetDir, stdio: "ignore" });
  try {
    if (run(["init"]).status !== 0) return;
    run(["add", "-A"]);
    run(["commit", "-m", "chore: scaffold hogsend app"]);
  } catch {
    // git missing or commit failed — scaffold is still valid, never fatal.
  }
}

function runInstall(targetDir: string, pm: CliOptions["packageManager"]): void {
  const result = spawnSync(pm, ["install"], {
    cwd: targetDir,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.warn(
      `\n  "${pm} install" did not complete. Run it manually in the app dir.`,
    );
  }
}

async function main(): Promise<void> {
  const opts = await resolveOptions(process.argv.slice(2));
  const targetDir = resolve(process.cwd(), opts.appName);

  if (await isNonEmptyDir(targetDir)) {
    throw new Error(`Target directory "${targetDir}" exists and is not empty.`);
  }

  console.log(`\n  Scaffolding ${opts.appName} ...`);
  await copyTemplate({
    templateDir: templateDir(),
    targetDir,
    appName: opts.appName,
    tarballDir: opts.useTarballs
      ? resolve(process.cwd(), opts.useTarballs)
      : undefined,
  });

  if (opts.git) tryGitInit(targetDir);
  if (opts.install) runInstall(targetDir, opts.packageManager);

  const pm = opts.packageManager;
  console.log(`
  Done. Next steps:

    cd ${opts.appName}${opts.install ? "" : `\n    ${pm} install`}
    cp .env.example .env        # fill BETTER_AUTH_SECRET, RESEND_API_KEY, HATCHET_CLIENT_TOKEN
    docker compose up -d        # Timescale + Redis + Hatchet-Lite
    ${pm} db:migrate            # engine track then client track
    ${pm} dev                   # HTTP API (port 3002)
    ${pm} worker:dev            # Hatchet worker (second terminal)

  Docs: see README.md
`);
}

main().catch((err: unknown) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
