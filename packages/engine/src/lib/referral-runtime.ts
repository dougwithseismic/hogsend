import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { AnalyticsProvider } from "@hogsend/core";
import type { JourneyRegistry } from "@hogsend/core/registry";
import type { Database } from "@hogsend/db";
import type { Logger } from "./logger.js";
import type { ReferralRegistry } from "./referral-registry.js";
import { createOptionalSingleton } from "./singleton.js";

/**
 * The handles the referral wiring needs at sites that hold no container:
 * `lib/contacts.ts` (bind, post-commit), `lib/ingestion.ts` (qualify +
 * convert) and journey-runtime `getReferralLink`. Installed once by
 * `createHogsendClient`.
 */
export interface ReferralRuntime {
  referrals: ReferralRegistry;
  db: Database;
  /** `env.API_PUBLIC_URL` - the tracking host every minted link is built on. */
  baseUrl: string;
  /**
   * The container's emit handles, so a library-code site (the bind in
   * `lib/contacts.ts`) reaches the SAME Hatchet client the container was built
   * with. Without them the intent layer would fall back to importing
   * `lib/hatchet.js`, whose module load runs `HatchetClient.init` and throws
   * where no real token exists.
   */
  hatchet: HatchetClient;
  registry: JourneyRegistry;
  logger: Logger;
  analytics?: AnalyticsProvider;
}

const _runtime = createOptionalSingleton<ReferralRuntime>();

export const setReferralRuntime = _runtime.set;

/**
 * The installed referral runtime, or `undefined`.
 *
 * OPTIONAL, not required: unlike the email/SMS services there is no stub to
 * install, and every consumer of this is a wired site that must stay INERT on
 * a deploy with no referrals. `undefined` therefore means "no referrals
 * configured", which is a legitimate steady state and never an error - so this
 * must not be switched to `createSingleton`, whose getter throws.
 */
export const getReferralRuntime = _runtime.get;

/** Reset the singleton - only for test cleanup. */
export const resetReferralRuntime = _runtime.reset;
