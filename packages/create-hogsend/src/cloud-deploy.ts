import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CloudDeployOptions } from "./prompts.js";

/**
 * The cloud handoff: scaffold → live instance, without leaving the command
 * (PRD 17).
 *
 * It drives the SCAFFOLDED APP'S OWN `hogsend` binary rather than anything this
 * package ships. That is the whole design:
 *
 *  - the CLI is already a template dependency, pinned to the same engine line
 *    the app depends on, so there is no version skew between the tool that
 *    deploys and the engine that runs;
 *  - no `dlx`, so no second download and no chance of the registry serving a
 *    different version than the one just installed;
 *  - and the flows themselves (PRD 15's email sign-in, PRD 16's self-healing
 *    publish with its provisioning narrative) are used AS SHIPPED. This module
 *    adds no auth logic, no polling and no output of its own — it spawns, it
 *    inherits stdio, and it reports what happened.
 *
 * THE INVARIANT THAT OUTRANKS EVERYTHING: a cloud failure never poisons the
 * scaffold. Every failure here is a returned verdict, never a throw, and the
 * caller prints resume commands and finishes the scaffold either way. The app
 * on disk is complete and locally usable whatever the control plane did.
 */

/** How far the handoff got, and what the human should do about it. */
export type CloudDeployStep = "resolve-cli" | "login" | "publish";

export type CloudDeployResult =
  | { ok: true }
  | { ok: false; step: CloudDeployStep; message: string };

export interface CloudDeployDeps {
  /**
   * Run a child to completion, inheriting stdio. Injected so a test can drive
   * the whole flow without a control plane — everything else here is path
   * resolution, which is exactly what a test should NOT stub.
   */
  run?(command: string, args: string[], cwd: string): number;
}

/**
 * `node_modules/@hogsend/cli/dist/bin.js` — the CLI's REAL entry point.
 *
 * Deliberately not `node_modules/.bin/hogsend`. Under pnpm that path is a shell
 * shim, not a JavaScript file, and `node node_modules/.bin/hogsend` crashes on
 * its first line; the scaffold's own package.json scripts already call the dist
 * entry for the same reason. Resolving it by hand (rather than with
 * `require.resolve`) keeps this working when the app is installed with a
 * different package manager, each of which lays out `node_modules` its own way
 * but all of which put the package itself here.
 */
export function resolveHogsendBin(targetDir: string): string | null {
  const entry = join(
    targetDir,
    "node_modules",
    "@hogsend",
    "cli",
    "dist",
    "bin.js",
  );
  return existsSync(entry) ? entry : null;
}

function defaultRun(command: string, args: string[], cwd: string): number {
  const result = spawnSync(command, args, {
    cwd,
    // INHERITED, and that is the feature: the sign-in prompt reads the
    // scaffolder's own TTY (or its piped stdin, for an agent with inbox
    // access), and the publish streams its provisioning + build narrative
    // straight through to the same screen. A captured pipe would turn a
    // five-minute deploy into five minutes of silence.
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) return 1;
  return result.status ?? 1;
}

/**
 * Sign in (creating the account if there is none) and publish.
 *
 * `hogsend signup`, not `hogsend login --email`, for two concrete reasons:
 *  - `signup` accepts `--org`; `login` deliberately refuses it (PRD 15 — a
 *    second organization is a real decision, not a flag on a login);
 *  - the two commands hit the SAME endpoints, and the control plane reports
 *    whether an account was created rather than the caller choosing, so
 *    `signup` covers the returning user perfectly well ("Welcome back").
 *
 * An org name is ALWAYS passed. Without one the child would prompt for it, and
 * the scaffolder promised exactly one cloud question; the app's own name is a
 * better default than an empty prompt, and the cloud ignores it for anybody
 * who already has an organization.
 */
export function runCloudDeploy(
  input: {
    targetDir: string;
    /** Fallback organization name when the caller supplied none. */
    appName: string;
    cloud: CloudDeployOptions;
  },
  deps: CloudDeployDeps = {},
): CloudDeployResult {
  const run = deps.run ?? defaultRun;

  const bin = resolveHogsendBin(input.targetDir);
  if (!bin) {
    return {
      ok: false,
      step: "resolve-cli",
      message:
        "The app's `hogsend` CLI is not installed, so there was nothing to deploy with.",
    };
  }

  const host = input.cloud.cloudUrl;
  const hostArgs = host === undefined ? [] : ["--cloud", host];

  const login = run(
    process.execPath,
    [
      bin,
      "signup",
      "--email",
      input.cloud.email,
      "--org",
      input.cloud.org ?? input.appName,
      ...hostArgs,
    ],
    input.targetDir,
  );
  if (login !== 0) {
    return {
      ok: false,
      step: "login",
      message: "Signing in to Hogsend Cloud did not finish.",
    };
  }

  const publish = run(
    process.execPath,
    [bin, "publish", ...hostArgs],
    input.targetDir,
  );
  if (publish !== 0) {
    return {
      ok: false,
      step: "publish",
      message: "The deploy did not finish.",
    };
  }

  return { ok: true };
}
