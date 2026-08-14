import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";

/**
 * `src/testing.ts` — the `@hogsend/engine/testing` entry point — is documented
 * side-effect-free, and `@hogsend/testing` re-exports from it. Consumers import
 * that package from an app that may have NO environment at all: the scaffold's
 * `[2c] clean packed-consumer runtime import` gate builds a throwaway project
 * whose only dependency is `@hogsend/testing`, writes a two-line file importing
 * `createJourneyTest`, and runs it with plain `tsx` and an empty environment.
 *
 * `src/env.ts` calls `createEnv` at MODULE SCOPE, so ANY static
 * `import { env }` anywhere in the barrel's import graph turns that into
 * "Invalid environment variables" — including one added several modules deep
 * (the barrel exports `softDeleteContact` from `lib/contacts.ts`, which reaches
 * `lib/account-links.ts`, which reaches `lib/provider-credentials.ts`).
 *
 * This has to run in a CHILD PROCESS: `env.ts` caches its validation on first
 * import, and this package's own suite runs with a full environment, so an
 * in-process `await import()` here would pass no matter what. And it strips the
 * environment rather than reading source, so it catches the edge WHEREVER in
 * the graph it reappears — not just in the files we already know about.
 */

/** Every var `src/env.ts` declares with no `.default()` / `.optional()`. */
const REQUIRED_ENGINE_VARS = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "HATCHET_CLIENT_TOKEN",
];

test("the testing barrel imports with no environment", () => {
  // Keep PATH/NODE_OPTIONS etc. so the child can still resolve its TypeScript
  // loader; drop exactly what `env.ts` demands.
  const env = { ...process.env };
  for (const name of REQUIRED_ENGINE_VARS) delete env[name];

  const barrel = pathToFileURL(
    new URL("./testing.ts", import.meta.url).pathname,
  ).href;

  let stdout: string;
  try {
    stdout = execFileSync(
      process.execPath,
      [
        ...process.execArgv,
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(barrel)});\nconsole.log("BARREL_OK");`,
      ],
      { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    const detail =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: unknown }).stderr)
        : String(err);
    assert.fail(
      "`@hogsend/engine/testing` no longer imports without an environment. " +
        "Something in its graph gained an import-time `env.ts` dependency — " +
        "use `lib/app-secret.ts` (or another lazy accessor) instead of a " +
        `static \`import { env }\`. Do NOT fix this by stubbing env vars in a test config; the scaffold gate runs plain \`tsx\` with none. Child stderr:\n${detail}`,
    );
  }

  assert.match(
    stdout,
    /BARREL_OK/,
    "child process did not reach the import — the probe itself is broken",
  );
});
