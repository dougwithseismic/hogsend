import { env } from "../env";
import { FakeSubstrate } from "./fake";
import { RailwaySubstrate } from "./railway";
import { SubstrateError, type SubstrateProvider } from "./types";

export type { FakeStackSnapshot, FakeSubstrateCall } from "./fake";
export { FAKE_SUBSTRATE_ID, FakeSubstrate, fakeApiPublicUrl } from "./fake";
export { RAILWAY_SUBSTRATE_ID, RailwaySubstrate } from "./railway";
export * from "./types";

/**
 * The single entry point every caller uses to reach infrastructure.
 *
 * Nothing in the control plane may construct a substrate directly — go through
 * here, and the choice of implementation stays one env var rather than an
 * import graph.
 */

/**
 * The fake is a SINGLETON per process, and has to be: its whole state is in
 * memory, so a fresh instance per call would lose every stack the moment a
 * request ended, and local dev could never see a provisioned stack twice.
 */
let fakeSingleton: FakeSubstrate | undefined;

/**
 * The Railway substrate is a singleton for a different reason: it is stateless
 * but holds a token and an HTTP client, and one instance per request would
 * throw away connection reuse for no benefit.
 */
let railwaySingleton: RailwaySubstrate | undefined;

export function getSubstrate(): SubstrateProvider {
  switch (env.CLOUD_SUBSTRATE) {
    case "fake":
      fakeSingleton ??= new FakeSubstrate();
      return fakeSingleton;
    case "railway":
      // Fail CLOSED, and say which of the two problems it is. Returning a fake
      // here would be the worst possible outcome: a dashboard reporting
      // healthy stacks that do not exist.
      if (!env.CLOUD_RAILWAY_TOKEN) {
        throw new SubstrateError(
          "CLOUD_SUBSTRATE=railway requires CLOUD_RAILWAY_TOKEN; refusing to start (a missing token never falls back to the fake substrate)",
        );
      }
      // Same fail-closed stance for pull credentials: half a pair is a
      // misconfiguration, and shipping services that fail their first private
      // pull would surface as a vendor outage instead of the real cause.
      if (
        Boolean(env.CLOUD_REGISTRY_USERNAME) !==
        Boolean(env.CLOUD_REGISTRY_PASSWORD)
      ) {
        throw new SubstrateError(
          "CLOUD_REGISTRY_USERNAME and CLOUD_REGISTRY_PASSWORD must be set together (or neither); refusing to start with half a credential pair",
        );
      }
      railwaySingleton ??= new RailwaySubstrate({
        token: env.CLOUD_RAILWAY_TOKEN,
        workspaceId: env.CLOUD_RAILWAY_WORKSPACE_ID,
        ...(env.CLOUD_REGISTRY_USERNAME && env.CLOUD_REGISTRY_PASSWORD
          ? {
              registryCredentials: {
                username: env.CLOUD_REGISTRY_USERNAME,
                password: env.CLOUD_REGISTRY_PASSWORD,
              },
            }
          : {}),
      });
      return railwaySingleton;
  }
}

/** Test/dev helper: the process-wide fake, or a throw if it is not the active
 * substrate. Lets a dev-only route inspect state without re-reading env. */
export function getFakeSubstrate(): FakeSubstrate {
  const provider = getSubstrate();
  if (!(provider instanceof FakeSubstrate)) {
    throw new SubstrateError(
      `the active substrate is "${env.CLOUD_SUBSTRATE}", not the fake`,
    );
  }
  return provider;
}
