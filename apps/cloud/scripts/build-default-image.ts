/**
 * Build the STOCK SCAFFOLD IMAGE — `hogsend-default:<engine-version>` — the
 * image a freshly provisioned stack boots on before its owner has published
 * anything (PRD 04 "initial deploy source", PRD 08 task 3).
 *
 *   pnpm --filter @hogsend/cloud build:default-image
 *   pnpm --filter @hogsend/cloud build:default-image -- --keep
 *   CLOUD_IMAGE_REGISTRY=ghcr.io/withseismic pnpm … build:default-image
 *
 * It scaffolds a FRESH create-hogsend app into a temp directory and then runs
 * the SAME machinery a tenant publish does — `DockerImageStore` for the build
 * and the push, `runPreflight` for the gate. That is the whole point: the image
 * every new stack starts on is produced by the pipeline it will later be
 * replaced by, so a defect in one is a defect in both and cannot hide in the
 * gap between a bespoke script and the real path.
 *
 * The engine version is READ from the app that was actually generated, never
 * assumed: the tag has to name what is in the image. When that disagrees with
 * `CLOUD_DEFAULT_ENGINE_VERSION` — the version provisioning will ask the
 * substrate to pull — the script says so loudly, because the two silently
 * drifting is exactly how a stack ends up pointed at an image nobody built.
 *
 * Requires docker on the host. With no `CLOUD_IMAGE_REGISTRY` the image stays
 * local and the push is a logged no-op (dev).
 */
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../src/env";
import { DockerImageStore } from "../src/images/docker";
import { spawnExec } from "../src/images/exec";
import { defaultImageTag } from "../src/images/tags";
import { pathExists, runPreflight } from "../src/pipeline/build";

/** The directory name the scaffold is generated into. Never user-visible. */
const APP_NAME = "hogsend-default";

/**
 * The argv `scaffold()` hands create-hogsend after the app name.
 *
 * `--with hogsend` is LOAD-BEARING. Provisioning sets `EMAIL_PROVIDER=hogsend`
 * on every stack with a real SES tenancy (`emailProviderVars`), and the
 * engine resolves that id through a guarded dynamic
 * `import("@hogsend/plugin-hogsend")` against the APP's node_modules —
 * `@hogsend/plugin-hogsend` is an opt-in scaffold plugin, deliberately absent
 * from the template's defaults, and an engine-only `optionalDependency` is
 * never linked at the app's top level (#611). Only this flag makes the
 * generated app carry the plugin as a DIRECT dependency; drop it and every
 * fresh stack throws `email provider "hogsend" is not registered` at boot and
 * crash-loops. (The create-hogsend smoke deliberately does NOT scaffold with
 * it — hogsend's env block appends to `.env.example`, which would break that
 * smoke's byte-identity diff. This scaffold has no such check.)
 *
 * Nothing asserts on this argv directly: the coverage test goes through
 * `defaultImageProviderIds()`, which answers the question that actually
 * matters — which providers the image can resolve — rather than how this
 * script spells the request.
 */
export const DEFAULT_IMAGE_SCAFFOLD_ARGS: readonly string[] = [
  "--yes",
  "--pm",
  "pnpm",
  "--no-install",
  "--no-setup",
  "--no-git",
  "--no-skills",
  "--no-posthog",
  "--with",
  "hogsend",
];

/**
 * Every Hogsend provider plugin is `@hogsend/plugin-<provider id>`, and the
 * engine's presets import exactly that specifier for the id they register
 * (`packages/engine/src/lib/email-providers-from-env.ts`). So the package name
 * is derivable from the id, and vice versa.
 */
const PLUGIN_SCOPE = "@hogsend/plugin-";

/**
 * The optional-plugin ids the argv above selects, parsed the way create-hogsend
 * parses them (`--with` is repeatable AND each value may be a comma-separated
 * list). Read back OUT of the argv rather than declared beside it, so the argv
 * stays the single source of truth for what this script asks the scaffolder for
 * and the two can never disagree.
 */
function selectedPluginIds(argv: readonly string[]): string[] {
  const ids: string[] = [];
  for (const [index, arg] of argv.entries()) {
    if (arg !== "--with") continue;
    for (const raw of (argv[index + 1] ?? "").split(",")) {
      const id = raw.trim();
      if (id !== "" && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/**
 * The provider ids the app inside the stock image can RESOLVE at boot.
 *
 * A provider resolves only when its plugin package is a DIRECT dependency of
 * the generated app: the app bundles the engine, so the engine's guarded
 * dynamic `import("@hogsend/plugin-<id>")` resolves against the APP's
 * node_modules, where an engine-only `optionalDependency` is never linked
 * (#611). So this reads the two — and only the two — inputs that decide that
 * set: the scaffold template's own dependency manifest (the defaults every app
 * gets, e.g. Resend) and the opt-in plugins this script selects with `--with`.
 * Both are read from the real artifacts, so the answer follows a template or
 * argv change without anyone remembering to update it here.
 *
 * A superset that spans channels — `plugin-posthog` contributes the analytics
 * id `posthog` — because the naming convention cannot tell channels apart.
 * That is fine for its one job: proving that everything the provisioner may
 * SELECT is in here (`provision-pipeline.test.ts`). Membership is the claim,
 * never equality.
 *
 * Exported so that claim can be checked without docker or a real scaffold.
 */
export async function defaultImageProviderIds(): Promise<Set<string>> {
  const manifest = join(createHogsendDir(), "template", "_package.json");
  const template = JSON.parse(await readFile(manifest, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const direct = new Set(Object.keys(template.dependencies ?? {}));
  if (!direct.has("@hogsend/engine")) {
    throw new Error(
      `${manifest} has no @hogsend/engine dependency — this is not the scaffold template manifest, so the providers it yields cannot be trusted`,
    );
  }
  for (const id of selectedPluginIds(DEFAULT_IMAGE_SCAFFOLD_ARGS)) {
    direct.add(`${PLUGIN_SCOPE}${id}`);
  }

  const ids = new Set<string>();
  for (const dependency of direct) {
    if (dependency.startsWith(PLUGIN_SCOPE)) {
      ids.add(dependency.slice(PLUGIN_SCOPE.length));
    }
  }
  return ids;
}

interface Options {
  /** Override the version read from the scaffold. */
  engineVersion?: string;
  /** Leave the temp scaffold on disk for inspection. */
  keep: boolean;
  /** Build only — skip the gate. For iterating on the Dockerfile. */
  skipPreflight: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { keep: false, skipPreflight: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--keep") options.keep = true;
    else if (arg === "--no-preflight") options.skipPreflight = true;
    else if (arg === "--engine-version") {
      index += 1;
      options.engineVersion = argv[index];
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        "usage: build-default-image [--engine-version <v>] [--no-preflight] [--keep]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument "${arg}" (try --help)`);
    }
  }
  return options;
}

function log(message: string): void {
  process.stdout.write(`▶ ${message}\n`);
}

function stream(chunk: string): void {
  process.stdout.write(chunk);
}

/** `packages/create-hogsend`, resolved from this script's location. */
function createHogsendDir(): string {
  return fileURLToPath(
    new URL("../../../packages/create-hogsend", import.meta.url),
  );
}

/**
 * Generate the app.
 *
 * The BUILT CLI is preferred and `tsx` over its source is the fallback, so a
 * clean checkout works without a build step. Everything optional is turned off:
 * no install (the Dockerfile resolves dependencies itself), no local setup (it
 * wants Docker services), no git, no skills — this image is a runtime, not a
 * workspace. The ONE opt-in is `--with hogsend`, which the image cannot boot
 * without (see `DEFAULT_IMAGE_SCAFFOLD_ARGS`).
 */
async function scaffold(workRoot: string): Promise<string> {
  const packageDir = createHogsendDir();
  const built = join(packageDir, "dist", "index.js");
  const useBuilt = await pathExists(built);
  const command = useBuilt ? process.execPath : "pnpm";
  const prefix = useBuilt
    ? [built]
    : ["exec", "tsx", join(packageDir, "src", "index.ts")];

  log(
    `scaffolding a fresh create-hogsend app with ${useBuilt ? "dist/index.js" : "tsx src/index.ts"} …`,
  );
  const result = await spawnExec(
    command,
    [...prefix, APP_NAME, ...DEFAULT_IMAGE_SCAFFOLD_ARGS],
    { cwd: workRoot, onOutput: stream },
  );
  if (result.code !== 0) {
    throw new Error(`create-hogsend exited ${result.code}`);
  }

  const appDir = join(workRoot, APP_NAME);
  if (!(await pathExists(join(appDir, "package.json")))) {
    throw new Error(`create-hogsend produced no app at ${appDir}`);
  }
  return appDir;
}

/** The engine version the generated app actually pins. */
async function readEngineVersion(appDir: string): Promise<string> {
  const pkg = JSON.parse(
    await readFile(join(appDir, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const pinned = pkg.dependencies?.["@hogsend/engine"];
  if (!pinned) {
    throw new Error(
      "the scaffolded app has no @hogsend/engine dependency — cannot name the image",
    );
  }
  return pinned.replace(/^[\^~]/, "");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const workRoot = await mkdtemp(join(tmpdir(), "hogsend-default-image-"));

  try {
    const appDir = await scaffold(workRoot);
    const engineVersion =
      options.engineVersion ?? (await readEngineVersion(appDir));
    if (engineVersion !== env.CLOUD_DEFAULT_ENGINE_VERSION) {
      log(
        `NOTE: this image is ${engineVersion}, but CLOUD_DEFAULT_ENGINE_VERSION is ${env.CLOUD_DEFAULT_ENGINE_VERSION}. Provisioning will ask the substrate for hogsend-default:${env.CLOUD_DEFAULT_ENGINE_VERSION} — set them to the same value or new stacks will fail to pull.`,
      );
    }

    const tag = defaultImageTag(engineVersion);
    const store = new DockerImageStore({
      registry: env.CLOUD_IMAGE_REGISTRY,
      onNotice: log,
    });
    const reference = store.reference(tag);

    log(`building ${reference} …`);
    await store.build({
      contextDir: appDir,
      dockerfile: join(appDir, "Dockerfile"),
      tag,
      onOutput: stream,
    });

    if (options.skipPreflight) {
      log("skipping the preflight gate (--no-preflight)");
    } else {
      log(`preflighting ${reference} …`);
      const preflight = await runPreflight({
        exec: spawnExec,
        scriptPath: join(appDir, "scripts", "preflight.sh"),
        cwd: appDir,
        reference,
        logDir: join(workRoot, "preflight-logs"),
        onOutput: stream,
      });
      if (!preflight.ok) {
        throw new Error(
          `the preflight gate refused ${reference} (exit ${preflight.code}) — the image was NOT pushed`,
        );
      }
    }

    const pushed = await store.push({ tag, onOutput: stream });
    process.stdout.write(
      `${JSON.stringify(
        {
          image: pushed.reference,
          engineVersion,
          digest: pushed.digest,
          pushed: pushed.pushed,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    if (options.keep) {
      log(`kept the scaffold at ${workRoot}`);
    } else {
      await rm(workRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Whether this file is the process entry point (`pnpm build:default-image` →
 * tsx). The module is ALSO imported by the test suite to ask
 * `defaultImageProviderIds()`, and an import must never kick off a docker
 * build. Realpath BOTH sides: macOS hands out symlinked paths (`/tmp` →
 * `/private/tmp`), and a naive string compare would silently no-op the script.
 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `✗ ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
