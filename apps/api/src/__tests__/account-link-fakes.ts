import {
  type AccountLinkProvider,
  type AuthorizeUrlArgs,
  defineAccountLink,
  type HandleCallbackArgs,
  type LinkedIdentity,
} from "@hogsend/core";

/**
 * Deterministic account-link provider Fakes for the PRD 07 route suites.
 *
 * Built with the REAL `defineAccountLink`, so every authoring guard (id shape,
 * reserved ids, the tokens/refresh pairing) applies exactly as it does in
 * production. They perform NO network I/O of any kind: the whole hosted flow is
 * exercised end to end with zero credentials, which is what the PRD 06 Fakes
 * were built first for.
 *
 * `calls` is the point of the Fake rather than a convenience. "The state was
 * verified BEFORE any code was exchanged" is only a real assertion if something
 * records that `handleCallback` was never reached.
 */
export interface FakeAccountLink extends AccountLinkProvider {
  calls: {
    authorizeUrl: AuthorizeUrlArgs[];
    handleCallback: HandleCallbackArgs[];
  };
  /**
   * Re-arm the Fake between cases. The container is built ONCE per file (a
   * container per test would open a Postgres pool per test), so the identity a
   * callback proves has to be settable rather than frozen at construction.
   */
  proves(identity: LinkedIdentity): void;
  /** Make the next `handleCallback` throw, or clear a previously set error. */
  fails(error: Error | null): void;
}

export interface FakeAccountLinkOptions {
  id: string;
  name?: string;
  pkce?: boolean;
  tokens?: boolean;
  multiple?: boolean;
  onConflict?: "replace" | "reject";
  /** What `handleCallback` proves. Defaults to a Steam-shaped id-only identity. */
  identity?: LinkedIdentity;
  /** When set, `handleCallback` throws this instead of returning. */
  throws?: Error;
}

export function fakeAccountLink(
  options: FakeAccountLinkOptions,
): FakeAccountLink {
  const calls: FakeAccountLink["calls"] = {
    authorizeUrl: [],
    handleCallback: [],
  };
  let identity: LinkedIdentity = options.identity ?? {
    providerUserId: "76561197960435530",
    username: "fake-player",
  };
  let error: Error | null = options.throws ?? null;

  const provider = defineAccountLink({
    meta: { id: options.id, name: options.name ?? options.id },
    ...(options.pkce || options.tokens
      ? {
          capabilities: {
            ...(options.pkce ? { pkce: true as const } : {}),
            ...(options.tokens ? { tokens: true as const } : {}),
          },
        }
      : {}),
    ...(options.multiple !== undefined ? { multiple: options.multiple } : {}),
    ...(options.onConflict !== undefined
      ? { onConflict: options.onConflict }
      : {}),

    authorizeUrl(args) {
      calls.authorizeUrl.push(args);
      const url = new URL(`https://provider.test/${options.id}/authorize`);
      url.searchParams.set("state", args.state);
      url.searchParams.set("redirect_uri", args.redirectUri);
      if (args.codeChallenge) {
        url.searchParams.set("code_challenge", args.codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
      }
      return url.toString();
    },

    async handleCallback(args) {
      calls.handleCallback.push(args);
      if (error) throw error;
      return identity;
    },
  }) as FakeAccountLink;

  provider.calls = calls;
  provider.proves = (next) => {
    identity = next;
  };
  provider.fails = (next) => {
    error = next;
  };
  return provider;
}
