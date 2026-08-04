import { env } from "../env";
import { CloudflareDns } from "./cloudflare";
import { FakeDns } from "./fake";
import { DnsError, type DnsProvider } from "./types";

export type {
  CloudflareDnsOptions,
  CloudflareHttpRequest,
  CloudflareHttpResponse,
  CloudflareTransport,
} from "./cloudflare";
export {
  CLOUDFLARE_API_URL,
  CLOUDFLARE_DNS_ID,
  CloudflareDns,
} from "./cloudflare";
export { FAKE_DNS_ID, FakeDns } from "./fake";
export * from "./types";

/**
 * The single entry point for DNS writes, mirroring `getSubstrate()`.
 *
 * Nothing constructs a provider directly: the choice stays one env var rather
 * than an import graph, and the fail-closed check below stays in one place.
 */

/**
 * The fake is a SINGLETON per process for the same reason the fake substrate
 * is: its whole state is in memory, and a fresh instance per call would forget
 * every record the moment a request ended.
 */
let fakeSingleton: FakeDns | undefined;

/** Stateless but holds a token; one instance keeps connection reuse. */
let cloudflareSingleton: CloudflareDns | undefined;

export function getDns(): DnsProvider {
  switch (env.CLOUD_DNS) {
    case "fake":
      fakeSingleton ??= new FakeDns();
      return fakeSingleton;
    case "cloudflare":
      // Fail CLOSED, and name which piece is missing. Falling back to the fake
      // would be the worst outcome available: a control plane reporting
      // hostnames that resolve nowhere.
      if (
        !env.CLOUD_CLOUDFLARE_TOKEN ||
        !env.CLOUD_CLOUDFLARE_ZONE_ID ||
        !env.CLOUD_CLOUDFLARE_ZONE_NAME
      ) {
        throw new DnsError(
          'CLOUD_DNS="cloudflare" requires CLOUD_CLOUDFLARE_TOKEN, CLOUD_CLOUDFLARE_ZONE_ID and CLOUD_CLOUDFLARE_ZONE_NAME; refusing to start (a missing credential never falls back to the fake)',
        );
      }
      cloudflareSingleton ??= new CloudflareDns({
        token: env.CLOUD_CLOUDFLARE_TOKEN,
        zoneId: env.CLOUD_CLOUDFLARE_ZONE_ID,
        zoneName: env.CLOUD_CLOUDFLARE_ZONE_NAME,
      });
      return cloudflareSingleton;
  }
}

/** Test/dev helper: the process-wide fake, or a throw if it is not active. */
export function getFakeDns(): FakeDns {
  const provider = getDns();
  if (!(provider instanceof FakeDns)) {
    throw new DnsError(
      `the active DNS provider is "${env.CLOUD_DNS}", not the fake`,
    );
  }
  return provider;
}
