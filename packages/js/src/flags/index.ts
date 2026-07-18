/**
 * Native feature-flags client — speaks the engine's `GET /v1/flags` contract.
 * Identity is resolved SERVER-SIDE from the query params (userToken when
 * identified, else anonymousId — the SAME leak boundary as the in-app feed),
 * so the client just forwards {@link identityParams} verbatim and writes the
 * returned `{ flags }` map into the reactive `flags` slice that `@hogsend/react`
 * selects against. Named `flags` (never `featureFlags`) so it coexists with
 * PostHog's `useFeatureFlag`.
 */

import { identityParams } from "../feed/index.js";
import type { IdentityStore } from "../identity/identity-store.js";
import type { Transport } from "../spine/transport.js";
import type { Store } from "../store/external-store.js";
import type { HogsendState } from "../types.js";

/** The evaluated flag map — arbitrary JSON values keyed by flag key. */
export type FlagsMap = Record<string, unknown>;

/** The `GET /v1/flags` envelope. */
interface FlagsResponse {
  flags: FlagsMap;
}

/** The flags sub-client. */
export interface FlagsClient {
  /**
   * Fetch the evaluated flag map for the current identity and write it into
   * the reactive `flags` slice. Resolves to the fetched map. NEVER rejects — a
   * transport failure (offline / 5xx / non-addressable anon / an engine that
   * predates the flags route) is swallowed and the current slice is returned,
   * so the fire-and-forget call sites can't raise an unhandled rejection.
   */
  refresh(): Promise<FlagsMap>;
  /**
   * Clear the flags slice back to empty. Called synchronously the moment the
   * identity flips so a previous user's flags are never readable during (or,
   * on a failed refetch, after) an identify()/reset() transition.
   */
  clear(): void;
  /** The current evaluated flag map from the slice (`{}` until first fetch). */
  getAll(): FlagsMap;
  /** A single flag's value (undefined until loaded / when absent). */
  getFlag(key: string): unknown;
  /** The reactive store the flags slice lives in. */
  readonly store: Store<HogsendState>;
}

/** Options for {@link createFlagsClient}. */
export interface FlagsClientOptions {
  transport: Transport;
  identity: IdentityStore;
  store: Store<HogsendState>;
}

const EMPTY_FLAGS: FlagsMap = {};

/** Build the flags client over the shared `flags` slice. */
export function createFlagsClient(opts: FlagsClientOptions): FlagsClient {
  const { transport, identity, store } = opts;

  function getAll(): FlagsMap {
    return store.getSnapshot().flags ?? EMPTY_FLAGS;
  }

  function write(flags: FlagsMap): void {
    store.setState((prev) => ({ ...prev, flags }));
  }

  function clear(): void {
    write(EMPTY_FLAGS);
  }

  async function refresh(): Promise<FlagsMap> {
    try {
      const res = await transport.get<FlagsResponse>(
        "/v1/flags",
        identityParams(identity),
      );
      const flags = res.flags ?? EMPTY_FLAGS;
      write(flags);
      return flags;
    } catch {
      // Transport failure — keep whatever slice we have (empty after a
      // just-cleared identity change, else the last-good map) and never let
      // the discarded promise surface as an unhandled rejection.
      return getAll();
    }
  }

  return {
    refresh,
    clear,
    getAll,
    getFlag: (key) => getAll()[key],
    store,
  };
}
