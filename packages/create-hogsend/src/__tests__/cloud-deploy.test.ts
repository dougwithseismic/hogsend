import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CLOUD_ENV_PULL_NOTE,
  CLOUD_HINT_NOTE,
  CLOUD_OPEN_NOTE,
  CLOUD_RESUME_INTRO,
  cloudNextCmds,
  cloudPublishCmd,
  cloudResumeCmds,
} from "../cloud.js";
import { resolveHogsendBin, runCloudDeploy } from "../cloud-deploy.js";

/**
 * `create-hogsend --cloud` (PRD 17).
 *
 * The invariant every case here exists to hold: A CLOUD FAILURE NEVER POISONS
 * THE SCAFFOLD. The app on disk must be complete and locally usable whatever
 * the control plane did, and the human must be told exactly how to pick the
 * deploy back up. So the failure cases assert the FILES, not just the words.
 *
 * The refusal case is the other half: `--cloud` with nowhere to mail a code
 * must be refused BEFORE anything is written, because a scaffold that appeared
 * and then announced it could not deploy leaves somebody with a directory they
 * did not ask about and an intention half-done.
 */

const PKG_DIR = fileURLToPath(new URL("../..", import.meta.url));
const CLI = join(PKG_DIR, "dist", "index.js");

let workdir: string;

beforeAll(() => {
  // The BUILT CLI, for the same reason `cloud-outro.test.ts` builds it: that is
  // what `pnpm dlx create-hogsend` actually runs.
  const built = spawnSync(
    "node",
    [join(PKG_DIR, "node_modules", "tsup", "dist", "cli-default.js")],
    { cwd: PKG_DIR, encoding: "utf8" },
  );
  if (built.status !== 0) {
    throw new Error(`tsup failed: ${built.stderr || built.stdout}`);
  }
  workdir = mkdtempSync(join(tmpdir(), "create-hogsend-cloud-"));
}, 120_000);

afterAll(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

/** Run the real scaffolder headlessly. Returns everything a caller can see. */
function scaffold(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    "node",
    [
      CLI,
      ...args,
      "--no-install",
      "--no-setup",
      "--no-git",
      "--no-posthog",
      "--no-skills",
    ],
    { cwd: workdir, encoding: "utf8" },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * Does this scaffold look complete? The files a usable app cannot lack: its
 * manifest, its source tree, its env template and its infra compose file.
 * Checked as FILES rather than as words in an outro, because "the scaffold
 * survives a failed deploy" is a claim about the disk.
 */
function looksComplete(dir: string): boolean {
  const at = (...parts: string[]) => existsSync(join(workdir, dir, ...parts));
  return (
    at("package.json") &&
    at("src", "index.ts") &&
    at(".env.example") &&
    at("docker-compose.yml")
  );
}

describe("the flag rules", () => {
  it("refuses --cloud with no --email headlessly, BEFORE writing anything", () => {
    const run = scaffold(["cloud-refused-app", "--cloud"]);

    expect(run.status).not.toBe(0);
    const said = run.stdout + run.stderr;
    expect(said).toContain("--cloud needs --email");
    // The exact shape of a working headless invocation, including how the code
    // gets in. "Missing flag" alone would leave an agent guessing at stdin.
    expect(said).toContain("echo 123456 | create-hogsend");
    // AND — the point of refusing this early — no directory was created.
    expect(existsSync(join(workdir, "cloud-refused-app"))).toBe(false);
  });

  it("refuses --email or --org without --cloud, so neither can silently do nothing", () => {
    const email = scaffold(["stray-email-app", "--email", "me@acme.test"]);
    expect(email.status).not.toBe(0);
    expect(email.stdout + email.stderr).toContain("require --cloud");
    expect(existsSync(join(workdir, "stray-email-app"))).toBe(false);

    const org = scaffold(["stray-org-app", "--org", "Acme"]);
    expect(org.status).not.toBe(0);
    expect(existsSync(join(workdir, "stray-org-app"))).toBe(false);
  });

  it("refuses a malformed --email before writing anything", () => {
    const run = scaffold([
      "bad-email-app",
      "--cloud",
      "--email",
      "not-an-email",
    ]);
    expect(run.status).not.toBe(0);
    expect(run.stdout + run.stderr).toContain("Invalid email");
    expect(existsSync(join(workdir, "bad-email-app"))).toBe(false);
  });
});

describe("a scaffold that opted OUT of cloud", () => {
  it("is byte-for-byte the outro it always was", () => {
    const run = scaffold(["no-cloud-app"]);

    expect(run.status).toBe(0);
    // The hint, unchanged — no cloud machinery leaks into a run that did not
    // ask for it.
    expect(run.stdout).toContain(cloudPublishCmd("pnpm"));
    expect(run.stdout).toContain(CLOUD_HINT_NOTE);
    // ...and nothing about deploying, resuming or opening an instance.
    expect(run.stdout).not.toContain(CLOUD_RESUME_INTRO);
    expect(run.stdout).not.toContain("Deploying to Hogsend Cloud");
    expect(run.stdout).not.toContain(CLOUD_OPEN_NOTE);
  });
});

describe("a cloud handoff that FAILS", () => {
  /**
   * `--no-install` guarantees the failure without a control plane: the CLI the
   * driver would run is one of the app's dependencies, and nothing installed
   * it. That is a real failure mode (an install that did not finish), not a
   * contrived one.
   */
  const run = () =>
    scaffold(["cloud-fail-app", "--cloud", "--email", "me@acme.test"]);

  it("leaves the scaffold COMPLETE and usable", () => {
    const result = run();

    // The whole invariant, asserted against the filesystem rather than the
    // wording: whatever happened to the deploy, this app is real.
    expect(looksComplete("cloud-fail-app")).toBe(true);
    expect(result.stdout).toContain("Welcome to Hogsend");
  });

  it("prints the exact commands that resume it", () => {
    // Its own directory: a scaffold refuses to write into a non-empty one, so
    // every case here scaffolds under a distinct name.
    const result = scaffold([
      "cloud-fail-resume-app",
      "--cloud",
      "--email",
      "me@acme.test",
    ]);

    const [signup, publish] = cloudResumeCmds("pnpm", {
      email: "me@acme.test",
    });
    expect(result.stdout).toContain(CLOUD_RESUME_INTRO);
    expect(result.stdout).toContain(signup ?? "");
    expect(result.stdout).toContain(publish ?? "");
    // The email is carried INTO the command, so the resume is a paste rather
    // than a fill-in-the-blank.
    expect(result.stdout).toContain("me@acme.test");
  });

  it("exits nonzero — the caller asked for an instance and has none", () => {
    const result = scaffold([
      "cloud-fail-exit-app",
      "--cloud",
      "--email",
      "me@acme.test",
    ]);

    // Deliberately unlike a failed bootstrap (which exits 0): `--cloud` is an
    // explicit request to end up deployed, and CI must be able to see that it
    // did not happen. The scaffold is still complete — both things are true.
    expect(result.status).not.toBe(0);
    expect(looksComplete("cloud-fail-exit-app")).toBe(true);
  });

  it("never prints a command with a blank address in it", () => {
    // The divergence the shared decision fixed: the plain-text outro used to
    // fall back to `opts.cloud?.email ?? ""`, so a resume block could read
    // `hogsend signup --email ` with nothing after the flag — a command that
    // looks copy-pasteable and is not. The coloured branch printed nothing at
    // all in the same case, which is worse than either: two outros, two
    // behaviours.
    const result = scaffold([
      "cloud-blank-email-app",
      "--cloud",
      "--email",
      "me@acme.test",
    ]);

    expect(result.stdout).toContain("--email me@acme.test");
    // No `--email` left dangling at a line end or followed only by spaces.
    expect(result.stdout).not.toMatch(/--email\s*$/m);
    expect(looksComplete("cloud-blank-email-app")).toBe(true);
  });

  it("carries a custom --cloud-url into the resume commands", () => {
    const result = scaffold([
      "cloud-fail-host-app",
      "--cloud",
      "--email",
      "me@acme.test",
      "--cloud-url",
      "http://localhost:3004",
    ]);

    // A scaffold pointed at a local or self-hosted control plane must not be
    // told to resume against the managed one.
    expect(result.stdout).toContain("--cloud http://localhost:3004");
    expect(looksComplete("cloud-fail-host-app")).toBe(true);
  });
});

describe("runCloudDeploy", () => {
  /** A fake installed app: just the one file the driver looks for. */
  function fakeApp(name: string): string {
    const dir = join(workdir, name);
    mkdirSync(join(dir, "node_modules", "@hogsend", "cli", "dist"), {
      recursive: true,
    });
    writeFileSync(
      join(dir, "node_modules", "@hogsend", "cli", "dist", "bin.js"),
      "",
    );
    return dir;
  }

  it("runs signup then publish, through the app's OWN cli entry", () => {
    const dir = fakeApp("driver-app");
    const calls: { command: string; args: string[]; cwd: string }[] = [];

    const result = runCloudDeploy(
      {
        targetDir: dir,
        appName: "driver-app",
        cloud: { email: "me@acme.test", cloudUrl: "http://localhost:3004" },
      },
      {
        run: (command, args, cwd) => {
          calls.push({ command, args, cwd });
          return 0;
        },
      },
    );

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(2);

    // NODE running the real dist entry — never `node node_modules/.bin/hogsend`,
    // which under pnpm is a shell shim that crashes on its first line.
    expect(calls[0]?.command).toBe(process.execPath);
    expect(calls[0]?.args[0]).toBe(
      join(dir, "node_modules", "@hogsend", "cli", "dist", "bin.js"),
    );
    expect(calls[0]?.args).toContain("signup");
    expect(calls[0]?.args).toContain("me@acme.test");
    // The org defaults to the app's own name, so the child never prompts for
    // one — the scaffolder promised exactly one cloud question.
    expect(calls[0]?.args).toContain("driver-app");
    expect(calls[0]?.args).toContain("--cloud");
    expect(calls[0]?.args).toContain("http://localhost:3004");

    expect(calls[1]?.args).toContain("publish");
    // Both run INSIDE the app: publish resolves the scaffold root from cwd.
    expect(calls[0]?.cwd).toBe(dir);
    expect(calls[1]?.cwd).toBe(dir);
  });

  it("prefers an explicit --org over the app name", () => {
    const dir = fakeApp("org-app");
    const calls: string[][] = [];
    runCloudDeploy(
      {
        targetDir: dir,
        appName: "org-app",
        cloud: { email: "me@acme.test", org: "Acme Rockets" },
      },
      {
        run: (_command, args) => {
          calls.push(args);
          return 0;
        },
      },
    );
    expect(calls[0]).toContain("Acme Rockets");
    expect(calls[0]).not.toContain("org-app");
  });

  it("stops at publish when the sign-in fails, and never throws", () => {
    const dir = fakeApp("login-fail-app");
    const calls: string[][] = [];

    const result = runCloudDeploy(
      {
        targetDir: dir,
        appName: "login-fail-app",
        cloud: { email: "me@acme.test" },
      },
      {
        run: (_command, args) => {
          calls.push(args);
          return 1;
        },
      },
    );

    expect(result).toEqual({
      ok: false,
      step: "login",
      message: "Signing in to Hogsend Cloud did not finish.",
    });
    // Publishing without a session would fail differently and confusingly.
    expect(calls).toHaveLength(1);
  });

  it("reports a missing CLI rather than spawning something that is not there", () => {
    const dir = join(workdir, "no-cli-app");
    mkdirSync(dir, { recursive: true });
    let ran = 0;

    const result = runCloudDeploy(
      {
        targetDir: dir,
        appName: "no-cli-app",
        cloud: { email: "me@acme.test" },
      },
      {
        run: () => {
          ran += 1;
          return 0;
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.step).toBe("resolve-cli");
    expect(ran).toBe(0);
    expect(resolveHogsendBin(dir)).toBeNull();
  });
});

describe("the success copy", () => {
  it("names `hogsend open` and `hogsend env pull`, not the hosting hint", () => {
    // The success outro is unreachable without a control plane, so the COPY is
    // held here and the wiring is held by the source assertions in
    // cloud-outro.test.ts. What matters is that a live app is told what to do
    // next rather than being re-offered the thing it just did.
    const [open, envPull] = cloudNextCmds("pnpm");
    expect(open).toBe("pnpm hogsend open");
    expect(envPull).toBe("pnpm hogsend env pull");
    expect(CLOUD_OPEN_NOTE).toContain("dashboard");
    expect(CLOUD_ENV_PULL_NOTE).toContain(".env");
  });

  it("builds resume commands per package manager", () => {
    expect(cloudResumeCmds("npm", { email: "me@acme.test" })).toEqual([
      "npx hogsend signup --email me@acme.test",
      "npx hogsend publish",
    ]);
    expect(
      cloudResumeCmds("pnpm", {
        email: "me@acme.test",
        cloudUrl: "http://localhost:3004",
      }),
    ).toEqual([
      "pnpm hogsend signup --email me@acme.test --cloud http://localhost:3004",
      "pnpm hogsend publish --cloud http://localhost:3004",
    ]);
  });
});
