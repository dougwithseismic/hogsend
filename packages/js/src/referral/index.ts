/**
 * Referral client: the caller's OWN share link, read from the engine's
 * `GET /v1/referrals/me` and written into the reactive `referral` slice that
 * `@hogsend/react` selects against (the same shape as the flags slice).
 *
 * ARRIVAL CAPTURE IS NOT HERE, BY DESIGN. A referral touch rides the existing
 * arrival beacon: the browser client already reads `hs_ref` off the URL on
 * init and posts it to `POST /v1/t/arrive`, and the engine turns that hit on a
 * `shared` link into the referral edge. There is no `capture()` on this
 * client, because adding one would be a second way to send the same beacon.
 * A host that routes before init still calls `hogsend.captureRef()`.
 *
 * The route is `userToken`-gated and NON-CONFIRMING: an absent, forged,
 * expired or unknown-user token returns `200 { link: null, stats: null }`,
 * byte-identical to a deploy with no referral registered. This client mirrors
 * that: with no bound `userToken` it never issues the request at all, and it
 * NEVER rejects. A 401/404/offline/older-engine response resolves to `null`.
 */

import type { IdentityStore } from "../identity/identity-store.js";
import type { Transport } from "../spine/transport.js";
import type { Store } from "../store/external-store.js";
import type { HogsendState, ReferralSliceState } from "../types.js";

/** The caller's share link. */
export interface ReferralLink {
  url: string;
  /** The vanity slug, when the link carries one. */
  slug: string | null;
}

/** Counts of the caller's own referrals. */
export interface ReferralStats {
  touched: number;
  bound: number;
  qualified: number;
}

/** The `GET /v1/referrals/me` envelope. */
export interface ReferralMe {
  link: ReferralLink | null;
  stats: ReferralStats | null;
}

/** Options for {@link ReferralClient.link}. */
export interface ReferralLinkOptions {
  /** The `defineReferral` id. Default `"default"` server-side. */
  referral?: string;
}

/** The referral sub-client. */
export interface ReferralClient {
  /**
   * Fetch the caller's link + counts and write them into the reactive
   * `referral` slice. Resolves to `{ link, stats }`, or `null` when there is
   * no bound `userToken`, when the token is not accepted, or when the request
   * fails. NEVER rejects.
   */
  link(opts?: ReferralLinkOptions): Promise<ReferralMe | null>;
  /** The last fetched link + counts from the slice, without a request. */
  getLink(): ReferralMe | null;
  /** Reset the slice (called on identify()/reset()). */
  clear(): void;
  /** The reactive store the `referral` slice lives in. */
  readonly store: Store<HogsendState>;
}

/** Options for {@link createReferralClient}. */
export interface ReferralClientOptions {
  transport: Transport;
  identity: IdentityStore;
  store: Store<HogsendState>;
}

const EMPTY: ReferralSliceState = { link: null, stats: null, loading: false };

/** Build the referral client over the shared `referral` slice. */
export function createReferralClient(
  opts: ReferralClientOptions,
): ReferralClient {
  const { transport, identity, store } = opts;

  function slice(): ReferralSliceState {
    return store.getSnapshot().referral ?? EMPTY;
  }

  function write(next: ReferralSliceState): void {
    store.setState((prev) => ({ ...prev, referral: next }));
  }

  function current(): ReferralMe | null {
    const { link, stats } = slice();
    return link ? { link, stats } : null;
  }

  async function link(o: ReferralLinkOptions = {}): Promise<ReferralMe | null> {
    const userToken = identity.getUserToken();
    // No server-minted token means the route can only answer with two nulls,
    // so spend no request on it.
    if (!userToken) {
      write(EMPTY);
      return null;
    }

    write({ ...slice(), loading: true });
    try {
      const res = await transport.get<ReferralMe>("/v1/referrals/me", {
        userToken,
        ...(o.referral ? { referral: o.referral } : {}),
      });
      const next: ReferralSliceState = {
        link: res.link ?? null,
        stats: res.stats ?? null,
        loading: false,
      };
      write(next);
      return next.link ? { link: next.link, stats: next.stats } : null;
    } catch {
      // 401 / 404 / offline / an engine that predates the route: the answer is
      // the same "no link" the route itself gives, never a rejection.
      write({ ...slice(), loading: false });
      return current();
    }
  }

  return {
    link,
    getLink: current,
    clear: () => write(EMPTY),
    store,
  };
}
