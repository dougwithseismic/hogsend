/**
 * Contact-traits client — speaks the engine's `GET /v1/contacts/me` contract.
 * Identity is resolved SERVER-SIDE from the query params (userToken when
 * identified, else anonymousId — the SAME leak boundary as flags and the
 * in-app feed), so the client forwards {@link identityParams} verbatim and
 * writes the returned projection into the reactive `contact` slice.
 *
 * The engine only returns traits the operator put on the `contacts`
 * publicProperties allowlist, so an unconfigured deploy reads `{}` here.
 */

import { identityParams } from "../feed/index.js";
import type { IdentityStore } from "../identity/identity-store.js";
import type { Transport } from "../spine/transport.js";
import type { Store } from "../store/external-store.js";
import type { ContactSlice, HogsendState } from "../types.js";

/** The allowlisted trait map — arbitrary JSON values keyed by trait name. */
export type ContactTraits = Record<string, unknown>;

/** The `GET /v1/contacts/me` envelope. */
interface ContactResponse {
  identified: boolean;
  traits: ContactTraits;
  email?: string | null;
}

/** The contact sub-client. */
export interface ContactClient {
  /**
   * Fetch the allowlisted projection for the current identity and write it
   * into the reactive `contact` slice. Resolves to the slice. NEVER rejects —
   * a transport failure (offline / 5xx / non-addressable anon / an engine that
   * predates the route) is swallowed and the current slice is returned, so the
   * fire-and-forget call sites can't raise an unhandled rejection.
   */
  refresh(): Promise<ContactSlice>;
  /**
   * Drop the contact slice back to empty. Called synchronously the moment the
   * identity flips so a previous user's traits are never readable during (or,
   * on a failed refetch, after) an identify()/reset() transition.
   */
  clear(): void;
  /** The current projection (empty + unidentified until the first fetch). */
  get(): ContactSlice;
  /** A single trait's value (undefined until loaded / when not allowlisted). */
  getTrait(key: string): unknown;
  /** The reactive store the contact slice lives in. */
  readonly store: Store<HogsendState>;
}

/** Options for {@link createContactClient}. */
export interface ContactClientOptions {
  transport: Transport;
  identity: IdentityStore;
  store: Store<HogsendState>;
}

const EMPTY_CONTACT: ContactSlice = { identified: false, traits: {} };

/** Build the contact client over the shared `contact` slice. */
export function createContactClient(opts: ContactClientOptions): ContactClient {
  const { transport, identity, store } = opts;

  // Monotonic issue counter. identify() fires TWO refreshes (one from the
  // distinctId-change subscriber, before the PUT /v1/contacts, and one after
  // it resolves), and responses can arrive out of order. Only the newest
  // issued fetch may write, so a stale pre-PUT projection can never overwrite
  // the fresh post-PUT one. clear() bumps it too, so an in-flight fetch from
  // before an identity flip is discarded rather than resurrecting old traits.
  let seq = 0;

  function get(): ContactSlice {
    return store.getSnapshot().contact ?? EMPTY_CONTACT;
  }

  function write(contact: ContactSlice): void {
    store.setState((prev) => ({ ...prev, contact }));
  }

  function clear(): void {
    seq += 1;
    write(EMPTY_CONTACT);
  }

  async function refresh(): Promise<ContactSlice> {
    const mine = ++seq;
    try {
      const res = await transport.get<ContactResponse>(
        "/v1/contacts/me",
        identityParams(identity),
      );
      if (mine !== seq) return get();
      const contact: ContactSlice = {
        identified: Boolean(res.identified),
        traits: res.traits ?? {},
        ...(res.email === undefined ? {} : { email: res.email }),
      };
      write(contact);
      return contact;
    } catch {
      // Transport failure — keep whatever slice we have (empty after a
      // just-cleared identity change, else the last-good projection) and never
      // let the discarded promise surface as an unhandled rejection.
      return get();
    }
  }

  return {
    refresh,
    clear,
    get,
    getTrait: (key) => get().traits[key],
    store,
  };
}
