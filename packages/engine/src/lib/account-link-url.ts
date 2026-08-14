import { randomBytes } from "node:crypto";
import { env } from "../env.js";
import { isAllowedReturnTo } from "./account-link-origins.js";
import { signConnectorState } from "./connector-state.js";

/**
 * Mint a WARM account-link URL for a KNOWN contact — the server-side half of
 * DECISIONS §2's naming (`mintAccountLinkUrl`, never `mintLinkUrl` beside
 * `mintLink`). PRD 09's `POST /v1/accounts/link-url` returns exactly this
 * value, and the embed SDK derives its `postMessage` `expectedOrigin` from it.
 *
 * **It returns an ENGINE-origin URL** (DECISIONS §15.2):
 *
 *     <API_PUBLIC_URL>/v1/accounts/<provider>/start?t=<signed account_link state>
 *
 * The provider's authorize URL is only ever a 302 target from `/start`, NEVER a
 * value handed to a caller. This is not tidiness: the embed compares the
 * `postMessage` origin against `new URL(url).origin`, so returning
 * `https://steamcommunity.com/...` would make it silently drop every success
 * message and time out while the link had committed server-side — and a
 * fake-`Window` test cannot see that.
 */
export class AccountLinkReturnToError extends Error {
  constructor(returnTo: string) {
    super(
      `returnTo "${returnTo}" is not on the account-link origin allowlist — ` +
        "add its origin to ACCOUNT_LINK_ALLOWED_ORIGINS (or " +
        "accountLinks.allowedOrigins)",
    );
    this.name = "AccountLinkReturnToError";
  }
}

export interface MintAccountLinkUrlArgs {
  /** The `AccountLinkProvider` `meta.id`. Sealed into the state as `providerId`. */
  provider: string;
  /**
   * The contact this link attaches to, AUTHORITATIVELY. Sealed into the state,
   * so the callback binds here and never to the email the provider reports
   * (DECISIONS §6.3). Minting is an identity assertion, which is why PRD 09
   * gates the route on a server-minted userToken and never on a `pk_` key.
   */
  contactId: string;
  /** Where to send the player afterwards. Checked HERE and again at redirect. */
  returnTo?: string;
  /** The container's parsed allowlist. Required to accept a `returnTo` at all. */
  allowedOrigins?: readonly string[];
  /** Defaults to `env.API_PUBLIC_URL`. */
  apiPublicUrl?: string;
  /** Defaults to `env.ACCOUNT_LINK_STATE_TTL_SECONDS`. */
  ttlSeconds?: number;
}

export function mintAccountLinkUrl(args: MintAccountLinkUrlArgs): string {
  if (
    args.returnTo !== undefined &&
    !isAllowedReturnTo(args.returnTo, args.allowedOrigins ?? [])
  ) {
    // Refuse at MINT time as well as at redirect time. An unchecked value here
    // would be signed by us, and a signed open redirect is worse than an
    // unsigned one — it looks verified.
    throw new AccountLinkReturnToError(args.returnTo);
  }

  const state = signConnectorState(
    {
      purpose: "account_link",
      providerId: args.provider,
      contactId: args.contactId,
      ...(args.returnTo ? { returnTo: args.returnTo } : {}),
      nonce: randomBytes(16).toString("base64url"),
    },
    env.BETTER_AUTH_SECRET,
    args.ttlSeconds ?? env.ACCOUNT_LINK_STATE_TTL_SECONDS,
  );

  // Trailing slash stripped for the same reason the SMS webhook route strips
  // it: it is the one operator-controlled degree of freedom in API_PUBLIC_URL.
  const base = (args.apiPublicUrl ?? env.API_PUBLIC_URL).replace(/\/+$/, "");
  const url = new URL(
    `${base}/v1/accounts/${encodeURIComponent(args.provider)}/start`,
  );
  url.searchParams.set("t", state);
  return url.toString();
}
