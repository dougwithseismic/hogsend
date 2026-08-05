/**
 * `@hogsend/cli/cloud` — the cloud seam, as an importable library.
 *
 * WHY THIS EXISTS: `@hogsend/mcp` needs to publish a scaffold, sign a machine
 * in and read a build's status — exactly what `hogsend publish`, `hogsend
 * signup` and `hogsend whoami` do. A second implementation of any of it would
 * be a second set of refusals, a second tarball exclude list and a second
 * credentials writer, and the first time they disagreed it would be about
 * something security-shaped (which files leave the machine, where a token is
 * written). So the CLI owns one copy and exports it.
 *
 * WHY AN EXPORTS ENTRY RATHER THAN A NEW PACKAGE: nothing forces one. The CLI
 * already owns these modules, they are already the tested path, and a
 * `@hogsend/cloud-lib` would be a third package to version, publish and keep in
 * step for zero behavioural gain. The cost of this choice is that a consumer
 * declaring `@hogsend/cli` pulls its install graph — which is why the MCP
 * package takes it as a devDependency and BUNDLES this surface into its stdio
 * bin (see that package's tsup config), exactly as it already does for the
 * engine.
 *
 * WHAT MAY LIVE BEHIND THIS DOOR: modules that talk to the CONTROL PLANE or to
 * the local scaffold, and nothing else. Every module re-exported here is free
 * of `@hogsend/engine` and `@hogsend/db` imports, and that is load-bearing
 * rather than incidental — the MCP stdio bin exists partly to avoid dragging
 * the engine graph into `npx @hogsend/mcp`. Adding an engine-importing module
 * here would silently undo that.
 *
 * NOT exported: anything that renders (`output.ts`), prompts (`prompt.ts`) or
 * reads argv. A library consumer owns its own presentation; what it needs from
 * here is the conversation with the cloud.
 */

// Where the cloud IS (flag > env > .env > default) — the shared config funnel.
export {
  type ResolvedCloud,
  resolveCloud,
} from "./lib/cloud-config.js";
// The control plane's HTTP client and its refusal type.
export {
  type CloudClient,
  type CloudClientOptions,
  CloudError,
  createCloudClient,
  type FetchLike,
  isCloudError,
} from "./lib/cloud-http.js";
// Every way the cloud says no, turned into something with a next move in it.
export {
  describeCloudRefusal,
  formatRefusal,
  type RefusalContext,
  type RenderedRefusal,
} from "./lib/cloud-refusals.js";

// Resolve the host + stored session into a bound client.
export {
  type CloudSession,
  type CloudSessionOptions,
  NotLoggedInError,
  openCloudSession,
  requireCloudSession,
  type StoredLoginLabels,
  storeCloudLogin,
} from "./lib/cloud-session.js";
// `~/.hogsend/credentials.json` — the ONE store, so a session minted by an MCP
// tool is a session the CLI can use, and vice versa.
export {
  type CloudCredential,
  CREDENTIALS_MODE,
  credentialsPath,
  deleteCloudCredential,
  readCloudCredential,
  readCredentials,
  writeCloudCredential,
} from "./lib/credentials.js";

// Email-OTP sign-in (PRD 15) — the flow behind `hogsend signup` / `login
// --email`, with every side effect injected.
export {
  DEFAULT_INTERACTIVE_ATTEMPTS,
  type EmailLoginDeps,
  EmailLoginError,
  type EmailLoginFailure,
  type EmailLoginOptions,
  type EmailLoginResult,
  runEmailLogin,
  type SignupSendResponse,
  type SignupVerifyResponse,
  verifyEmailCode,
} from "./lib/email-login.js";

// The publish conversation: pick an environment, upload, watch (PRD 08/16).
export {
  asPublishRefusal,
  assertBuildSucceeded,
  type BuildStatusResponse,
  type CloudEnvironment,
  DEFAULT_BUILD_TIMEOUT_MS,
  DEFAULT_PROVISION_TIMEOUT_MS,
  type EnvironmentListResponse,
  POLL_INTERVAL_MS,
  PROVISIONING_STACK_STATUSES,
  PublishError,
  type PublishFlowDeps,
  selectEnvironment,
  type UploadInput,
  type UploadResult,
  uploadPublish,
  type WatchOptions,
  watchBuild,
} from "./lib/publish-flow.js";
// Which app is being published, and against which engine.
export {
  buildManifest,
  ENGINE_PACKAGE,
  type EngineVersionSource,
  findScaffoldRoot,
  type PublishManifest,
  type ResolvedEngineVersion,
  resolveEngineVersion,
  ScaffoldError,
  type ScaffoldRoot,
} from "./lib/publish-manifest.js";
// What gets uploaded. The hard-exclude list here is a security boundary — the
// poisoned-fixture suite runs against THIS surface precisely because both the
// CLI and MCP callers must inherit the same one.
export {
  type BuildTarballOptions,
  type BuildTarballResult,
  buildPublishTarball,
  collectFiles,
  ENV_FILE_PATTERN,
  HARD_EXCLUDED_NAMES,
  isHardExcluded,
  MAX_TARBALL_BYTES,
  type PackedEntry,
  PublishTarballError,
} from "./lib/publish-tarball.js";
