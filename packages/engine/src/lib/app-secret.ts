/**
 * Lazy access to `env.BETTER_AUTH_SECRET`, the engine's one master secret
 * (AES-256-GCM key material for sealed link tokens and stored provider
 * credentials).
 *
 * WHY THIS MODULE EXISTS: `../env.js` calls `createEnv` at MODULE SCOPE, so a
 * static `import { env }` anywhere makes that file's whole import graph
 * unloadable without a full, valid environment. `lib/account-links.ts` and
 * `lib/provider-credentials.ts` are both reachable from `src/testing.ts` — the
 * `@hogsend/engine/testing` entry point, which `@hogsend/testing` imports from
 * a consumer app that has NO environment at all (the scaffold's packed-consumer
 * smoke runs it under plain `tsx` with every var stripped). A static env import
 * on that path turns "import a journey test helper" into "Invalid environment
 * variables".
 *
 * Neither module reads the secret at module scope — only inside functions that
 * are already `async` — so resolving it lazily costs nothing and validates
 * EXACTLY the same contract: this loads the real `env.js`, it does not re-read
 * or re-validate `process.env` itself. In a running API/worker `env.js` is
 * already in the module cache (the container imports it at boot, so a bad
 * environment still fails fast at startup); here the `await` just hands back
 * the cached module.
 *
 * The promise is memoised, so the module is loaded — and, on a bad
 * environment, throws — exactly once.
 */

let secret: Promise<string> | undefined;

/** The validated `BETTER_AUTH_SECRET`, loading `env.js` on first use. */
export function getAppSecret(): Promise<string> {
  secret ??= import("../env.js").then((m) => m.env.BETTER_AUTH_SECRET);
  return secret;
}
