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

/**
 * The one misconfiguration that would be silently wrong rather than loudly
 * broken.
 *
 * A zone name is what switches `ensure-hostname` ON; the fake writes into
 * memory. Together they hand a production instance an `API_PUBLIC_URL` on a
 * hostname that resolves NOWHERE — and because that URL mints every tracked
 * link and signs the Studio cookie, the damage is silent until a customer's
 * mail goes out with dead links in it.
 *
 * Pure and exported so the rule is testable without re-importing the module
 * under a mutated environment.
 */
export function refuseFakeDns(input: {
  nodeEnv: string;
  dns: string;
  zoneName?: string | null;
}): string | null {
  if (input.nodeEnv !== "production") return null;
  if (input.dns !== "fake") return null;
  if (!input.zoneName) return null;
  return 'CLOUD_CLOUDFLARE_ZONE_NAME is set with CLOUD_DNS="fake" in production: instances would be given hostnames that resolve nowhere. Set CLOUD_DNS="cloudflare", or unset the zone to keep instances on the substrate URL.';
}

export function getDns(): DnsProvider {
  switch (env.CLOUD_DNS) {
    case "fake": {
      const refusal = refuseFakeDns({
        nodeEnv: env.NODE_ENV,
        dns: env.CLOUD_DNS,
        zoneName: env.CLOUD_CLOUDFLARE_ZONE_NAME,
      });
      if (refusal) throw new DnsError(refusal);
      fakeSingleton ??= new FakeDns();
      return fakeSingleton;
    }
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
