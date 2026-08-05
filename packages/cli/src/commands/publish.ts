import { parseArgs } from "node:util";
import { isCloudError } from "../lib/cloud-http.js";
import { describeCloudRefusal, formatRefusal } from "../lib/cloud-refusals.js";
import { requireCloudSession } from "../lib/cloud-session.js";
import {
  ensureCloudSession,
  type InlineAuthDeps,
  withReauth,
} from "../lib/inline-auth.js";
import { color } from "../lib/output.js";
import {
  assertBuildSucceeded,
  type EnvironmentListResponse,
  PublishError,
  selectEnvironment,
  uploadPublish,
  watchBuild,
} from "../lib/publish-flow.js";
import {
  buildManifest,
  findScaffoldRoot,
  resolveEngineVersion,
  ScaffoldError,
} from "../lib/publish-manifest.js";
import {
  buildPublishTarball,
  PublishTarballError,
} from "../lib/publish-tarball.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend publish [options]

Ship this app to a Hogsend Cloud environment.

Run it from anywhere inside your app — the scaffold root is found by walking up
to the nearest package.json depending on @hogsend/engine. Everything the
repository ignores is left out, and .git, node_modules, dist and every .env*
are excluded UNCONDITIONALLY, whatever .gitignore says.

The engine version comes from your lockfile, not from a flag. If it disagrees
with what the target stack is running, the cloud refuses the deploy — pass
--allow-upgrade when that change is what you meant.

Options:
  --env <name>       Environment to publish to (default: your production environment).
  --allow-upgrade    Accept an engine-version change on the target stack.
  --cloud <url>      Cloud host (default HOGSEND_CLOUD_URL, else https://cloud.hogsend.com).
  --cwd <dir>        Start the scaffold-root search here (default: the current directory).
  --no-wait          Upload and exit; don't watch the build.
  --json             Emit a single JSON result.
  -h, --help         Show this help.

Exit codes:
  0  the build succeeded (or --no-wait uploaded cleanly)
  1  refused, failed, or timed out

Examples:
  hogsend publish
  hogsend publish --env staging
  hogsend publish --allow-upgrade`;

const badge = `${color.bgMagenta(color.black(" hogsend "))} publish`;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

/**
 * TEST/DEV SEAM. `run` is reached from the router with only a
 * {@link CommandContext}, so there is no argument through which a caller can
 * inject the inline-auth flows or the poll cadence — the overrides live here,
 * module-scoped, exactly as `pipeline/enqueue.ts` does it on the cloud side.
 * Empty in production, where every default is the real thing.
 */
interface PublishSeams {
  auth?: InlineAuthDeps;
  /** Overridden so a test can walk a six-poll build without spending 18s. */
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

let seams: PublishSeams = {};

/** Install publish overrides for the next `run`. */
export function configurePublish(overrides: PublishSeams): void {
  seams = overrides;
}

/** Drop every override installed by {@link configurePublish}. */
export function resetPublish(): void {
  seams = {};
}

async function run(ctx: CommandContext): Promise<void> {
  const { values } = parseArgs({
    args: ctx.argv,
    allowPositionals: true,
    options: {
      env: { type: "string" },
      "allow-upgrade": { type: "boolean", default: false },
      cloud: { type: "string" },
      cwd: { type: "string" },
      "no-wait": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  const cloudOpts = values.cloud === undefined ? {} : { cloud: values.cloud };

  // 1 — the app.
  let scaffold: ReturnType<typeof findScaffoldRoot>;
  let engine: ReturnType<typeof resolveEngineVersion>;
  try {
    scaffold = findScaffoldRoot(values.cwd ?? process.cwd());
    engine = resolveEngineVersion(scaffold.dir);
  } catch (error) {
    if (error instanceof ScaffoldError) ctx.out.fail(error.message);
    throw error;
  }

  // 2 — the session. On a terminal with none, this SIGNS YOU IN rather than
  // sending you away to run a second command (PRD 16); headless, it refuses
  // with the exact command to run. Either way the publish below is unchanged.
  const authOptions = {
    ...cloudOpts,
    ...(values.cloud === undefined ? {} : { cloudFlag: values.cloud }),
  };
  let session = await ensureCloudSession(ctx, authOptions, seams.auth ?? {});

  const refusalContext = {
    cloudHost: session.cloud.host,
    cloudExplicit: session.cloud.explicit,
    ...(values.env === undefined ? {} : { envName: values.env }),
  };

  // Rebuilt after an inline re-auth, because the client is bound to a bearer
  // the cloud has stopped accepting. `let` rather than `const` for exactly
  // that: every step below reads the CURRENT client.
  let deps = {
    client: session.client,
    emit: (line: string) => ctx.out.log(line),
    sleep: seams.sleep ?? sleep,
    now: () => Date.now(),
  };

  /** Re-read the session (and everything bound to it) after signing in. */
  const rebind = (): void => {
    session = requireCloudSession(cloudOpts);
    deps = { ...deps, client: session.client };
  };

  ctx.out.intro(badge);

  const fail = (error: unknown): never => {
    if (error instanceof PublishError) {
      const body = error.logTail
        ? `${error.message}\n\n${error.logTail}`
        : error.message;
      ctx.out.fail(error.hint ? `${body}\n  ${error.hint}` : body);
    }
    if (isCloudError(error)) {
      ctx.out.fail(formatRefusal(describeCloudRefusal(error, refusalContext)));
    }
    throw error;
  };

  // 3 — the target. A name is tenant-scoped, so it is resolved through the
  // cloud rather than guessed at locally.
  let environment: ReturnType<typeof selectEnvironment>;
  try {
    // The FIRST call, and so the one where a revoked session is discovered —
    // before a minute of packing. A 401 here offers the same inline sign-in as
    // having no session at all, then retries exactly once.
    const listed = await withReauth(
      ctx,
      () =>
        ctx.out.step("Resolving environment", () =>
          deps.client.get<EnvironmentListResponse>("/api/cli/environments"),
        ),
      rebind,
      authOptions,
      seams.auth ?? {},
    );
    environment = selectEnvironment(listed.environments, values.env);
  } catch (error) {
    return fail(error);
  }

  // The stack's own version, when it has one, so a mismatch is named BEFORE a
  // minute of packing and uploading. The intake's 409 is still the enforcement.
  if (
    environment.engineVersion &&
    environment.engineVersion !== engine.version &&
    values["allow-upgrade"] !== true
  ) {
    ctx.out.fail(
      `Engine version mismatch (${environment.name}): the stack runs ${environment.engineVersion}, this app is built against ${engine.version} (from ${engine.source}).\n  If that change is intentional, re-run with --allow-upgrade.`,
    );
  }

  // 4 — the archive.
  let packed: ReturnType<typeof buildPublishTarball>;
  try {
    packed = await ctx.out.step("Packing", async () =>
      buildPublishTarball(scaffold.dir),
    );
  } catch (error) {
    if (error instanceof PublishTarballError) {
      const largest = error.largest
        .map((entry) => `    ${entry.path} (${mb(entry.bytes)})`)
        .join("\n");
      ctx.out.fail(
        largest.length > 0
          ? `${error.message}\n  Largest files:\n${largest}`
          : error.message,
      );
    }
    throw error;
  }

  const manifest = buildManifest({
    appName: scaffold.appName,
    engineVersion: engine.version,
    allowUpgrade: values["allow-upgrade"] === true,
  });

  ctx.out.log(
    color.dim(
      `  ${scaffold.appName} → ${environment.name} · ${packed.entries.length} files · ${mb(packed.uncompressedBytes)} → ${mb(packed.archive.byteLength)} gzipped · engine ${engine.version} (${engine.source})`,
    ),
  );

  // 5 — upload.
  let uploaded: Awaited<ReturnType<typeof uploadPublish>>;
  try {
    // Wrapped too: a session can be revoked between the listing and the
    // upload, and re-packing a tarball because of it would be a minute the
    // human did not need to spend.
    uploaded = await withReauth(
      ctx,
      () =>
        ctx.out.step("Uploading", () =>
          uploadPublish(
            {
              environmentId: environment.id,
              archive: packed.archive,
              manifest,
              filename: `${scaffold.appName.replace(/[^a-zA-Z0-9._-]/g, "-")}.tar.gz`,
            },
            deps,
            refusalContext,
          ),
        ),
      rebind,
      authOptions,
      seams.auth ?? {},
    );
  } catch (error) {
    return fail(error);
  }

  if (values["no-wait"] === true) {
    if (ctx.json) {
      ctx.out.json({
        published: true,
        buildId: uploaded.buildId,
        status: uploaded.status,
        environment: { id: environment.id, name: environment.name },
        engineVersion: engine.version,
        waited: false,
      });
      return;
    }
    // `log`, not `outro`: clack chrome is a NO-OP when stdout is not a TTY, so
    // the outro silently swallowed the build id in exactly the runs that were
    // going to script against it (PRD 07 known-minor, fixed here). The id is
    // the whole output of a --no-wait publish; it must survive a pipe.
    ctx.out.log(`Queued as build ${uploaded.buildId}.`);
    ctx.out.outro("Watch it on the environment's build page.");
    return;
  }

  // 6 — watch it to a terminal state, exiting nonzero on anything but success.
  try {
    const build = await watchBuild(
      {
        buildId: uploaded.buildId,
        ...(seams.pollIntervalMs === undefined
          ? {}
          : { intervalMs: seams.pollIntervalMs }),
      },
      deps,
      refusalContext,
    );
    assertBuildSucceeded(build);

    if (ctx.json) {
      ctx.out.json({
        published: true,
        buildId: build.id,
        status: build.status,
        environment: { id: environment.id, name: environment.name },
        engineVersion: build.engineVersion ?? engine.version,
        imageDigest: build.imageDigest,
        waited: true,
      });
      return;
    }
    ctx.out.outro(`${color.green("✓")} Deployed to ${environment.name}.`);
  } catch (error) {
    return fail(error);
  }
}

export const publishCommand: Command = {
  name: "publish",
  summary: "Ship this app to a Hogsend Cloud environment",
  usage,
  run,
};
