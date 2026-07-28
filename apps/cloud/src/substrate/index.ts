import { env } from "../env";
import { FakeSubstrate } from "./fake";
import { SubstrateError, type SubstrateProvider } from "./types";

export type { FakeStackSnapshot, FakeSubstrateCall } from "./fake";
export { FAKE_SUBSTRATE_ID, FakeSubstrate, fakeApiPublicUrl } from "./fake";
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
      throw new SubstrateError(
        "CLOUD_SUBSTRATE=railway is not implemented yet (PRD 04 task 5); use CLOUD_SUBSTRATE=fake until RailwaySubstrate ships",
      );
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
