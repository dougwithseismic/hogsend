import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLOUD_HINT_NOTE, cloudPublishCmd, SELF_HOST_NOTE } from "../cloud.js";

/**
 * The hosting copy in the scaffold outro (PRD 13 T5).
 *
 * Two levels, because the four output paths are not equally reachable:
 *  - the two "setup did not run" paths are driven END TO END here, against the
 *    real built CLI writing a real scaffold into a temp dir;
 *  - the two "setup ran" paths need Docker, a database and a Hatchet token, so
 *    they are held by reading the source and asserting the shared helper is
 *    called there too. A headless scaffold must not learn fewer facts than an
 *    interactive one, and that is the property at risk of rotting.
 */

const PKG_DIR = fileURLToPath(new URL("../..", import.meta.url));
const CLI = join(PKG_DIR, "dist", "index.js");

let workdir: string;

beforeAll(() => {
  // The CLI under test is the BUILT one — `dist/index.js` is what `pnpm dlx
  // create-hogsend` runs, and `test` does not depend on this package's own
  // build task.
  const built = spawnSync(
    "node",
    [join(PKG_DIR, "node_modules", "tsup", "dist", "cli-default.js")],
    {
      cwd: PKG_DIR,
      encoding: "utf8",
    },
  );
  if (built.status !== 0) {
    throw new Error(`tsup failed: ${built.stderr || built.stdout}`);
  }
  workdir = mkdtempSync(join(tmpdir(), "create-hogsend-outro-"));
}, 120_000);

afterAll(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

/** Scaffold for real, headless, doing no install / git / bootstrap. */
function scaffold(name: string, extra: string[] = []): string {
  const result = spawnSync(
    "node",
    [
      CLI,
      name,
      "--no-install",
      "--no-setup",
      "--no-git",
      "--no-posthog",
      "--no-skills",
      ...extra,
    ],
    { cwd: workdir, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`scaffold failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

describe("cloudPublishCmd", () => {
  it("names the commands the CLI actually ships, per package manager", () => {
    // `hogsend login` + `hogsend publish` are real commands in @hogsend/cli.
    expect(cloudPublishCmd("pnpm")).toBe(
      "pnpm hogsend login && pnpm hogsend publish",
    );
    // npm and bun reach a locally-installed bin through their own runner.
    expect(cloudPublishCmd("npm")).toBe(
      "npx hogsend login && npx hogsend publish",
    );
    expect(cloudPublishCmd("bun")).toBe(
      "bunx hogsend login && bunx hogsend publish",
    );
    expect(cloudPublishCmd("yarn")).toBe(
      "yarn hogsend login && yarn hogsend publish",
    );
  });
});

describe("the non-interactive outro", () => {
  it("prints the Cloud path and the self-host path", () => {
    const out = scaffold("outro-app");
    expect(out).toContain(cloudPublishCmd("pnpm"));
    expect(out).toContain(CLOUD_HINT_NOTE);
    expect(out).toContain(SELF_HOST_NOTE);
    // All three paths, not two: running it locally still comes first.
    expect(out).toContain("pnpm hogsend dev");
  });

  it("uses the chosen package manager, not a hardcoded pnpm", () => {
    const out = scaffold("outro-npm-app", ["--pm", "npm"]);
    expect(out).toContain(cloudPublishCmd("npm"));
    expect(out).not.toContain("pnpm hogsend publish");
  });
});

describe("every output path", () => {
  const source = readFileSync(join(PKG_DIR, "src", "index.ts"), "utf8");

  it("renders the hosting copy from the shared helper, never by hand", () => {
    // One command string in the package. A second hand-typed copy is how the
    // README and the outro drift apart.
    const hardcoded = source.match(/hogsend (login|publish)/g) ?? [];
    expect(hardcoded).toEqual([]);
  });

  it("covers the two setup-ran paths, which need Docker to run", () => {
    // Interactive + setup done: bootstrap prints its own summary and the
    // next-steps note is skipped, so the hosting lines are logged separately.
    //
    // `hostingLines` rather than `cloudLines` since PRD 17: the block now has
    // three shapes (the hint, the live-instance next steps, the resume
    // commands) and one of them is always printed. The delegation is asserted
    // below, so the no-cloud path is still held to the same copy.
    expect(source).toContain("log.info(hostingLines(opts, cloudResult)");
    // Non-interactive: one `cloudNote`, interpolated into BOTH branches.
    expect(source.match(/\$\{cloudNote\}/g) ?? []).toHaveLength(2);
  });

  it("falls back to the plain hosting hint when no cloud deploy ran", () => {
    // THE guard on "byte-identical outro when --cloud is absent": a null
    // result is the no-cloud case, and it must reach `cloudLines` — the same
    // helper, with the same copy, the four behavioural cases above assert.
    expect(source).toContain(
      "if (cloudResult === null) return cloudLines(opts)",
    );
  });
});
