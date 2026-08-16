import { getFakeSesClient, getSesClient } from "../ses/index";
import type { SubstrateRegion } from "../substrate/types";
import type { RelayProvider } from "./contract";
import { SesRelayProvider } from "./ses/ses-relay-provider";

export type {
  RelayEvent,
  RelayProvider,
  RelaySendBatchInput,
  RelaySendBatchResult,
  RelaySendInput,
  RelaySendResult,
} from "./contract";
export { SesRelayProvider } from "./ses/ses-relay-provider";

/**
 * The single entry point every caller uses to reach the relay.
 *
 * `SesRelayProvider` is a stateless wrapper over the region's `SesClient`, so
 * `getRelay` holds NO cache of its own: the per-region caching, region
 * resolution and the AWS-vs-Fake credential gate all live ONE layer down in
 * `getSesClient`, which is already cached. Minting a fresh wrapper per call is
 * free and keeps a single source of truth for "which wire is live" — there is
 * no second cache to reset or to drift from `getSesClient`.
 */
export function getRelay(region: SubstrateRegion): RelayProvider {
  // `getSesClient` throws on an unmapped region, so `getRelay` inherits that
  // refusal unchanged.
  return new SesRelayProvider(getSesClient(region));
}

/** Test/dev helper: a relay over the process-wide fake for a region, or a throw
 * if the AWS client is the active one. Reset via `resetSesClients()`. */
export function getFakeRelay(region: SubstrateRegion): RelayProvider {
  return new SesRelayProvider(getFakeSesClient(region));
}
