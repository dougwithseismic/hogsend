import { type DurationObject, durationToMs } from "../duration.js";

// ---------------------------------------------------------------------------
// The identity a provider proves
// ---------------------------------------------------------------------------

/**
 * The identity a provider proves. `providerUserId` is the platform's IMMUTABLE
 * id: Steam `steamid64`, Twitch numeric user id. It is NEVER a vanity name,
 * handle, display name or `#discriminator`: those are user-editable, so keying
 * a link on one lets a player rename themselves onto another player's link row.
 * {@link LinkedIdentity.username} is the place for the mutable label, and it is
 * DISPLAY DATA ONLY.
 */
export interface LinkedIdentity {
  providerUserId: string;
  /** Mutable display handle. Never a key. */
  username?: string;
  /**
   * Only set when the platform MARKS the address verified. An unverified
   * provider email is a property, not an identity key, and folding it in is the
   * grafting vector `plugin-discord/src/connector.ts:463` exists to close. Even
   * when verified it may MATCH a contact — it may never silently MERGE one.
   */
  verifiedEmail?: string;
  avatarUrl?: string;
  /** Present only when the provider declares `capabilities.tokens`. */
  tokens?: LinkTokens;
  /**
   * Scalars only — these land on `contacts.properties`, which journeys and
   * buckets read with no new machinery, so a nested object has nowhere to go.
   */
  properties?: Record<string, string | number | boolean | null>;
}

/**
 * The grant a token-holding provider yields. Sealed by the engine with its
 * AES-256-GCM helper into `linked_accounts.tokens`. Steam holds NOTHING here:
 * OpenID 2.0 issues no tokens at all.
 */
export interface LinkTokens {
  accessToken: string;
  refreshToken?: string;
  /** ISO 8601 with offset. */
  expiresAt?: string;
  scopes?: string[];
}

// ---------------------------------------------------------------------------
// Provider identity & capabilities
// ---------------------------------------------------------------------------

/**
 * Provider identity. `id` keys the registry and is the `:provider` segment of
 * `/v1/accounts/:provider/*`, so it is constrained by
 * {@link ACCOUNT_LINK_ID_RE} and may not collide with
 * {@link RESERVED_ACCOUNT_LINK_IDS}. REQUIRED (like `SmsProviderMeta`, unlike
 * the back-compat-optional `EmailProvider.meta`) — account links have no legacy
 * providers to protect.
 */
export interface AccountLinkMeta {
  id: string;
  name: string;
  description?: string;
}

/**
 * What the provider's flow can and can't do. All flags optional; absent is
 * treated conservatively (no tokens, no PKCE).
 */
export interface AccountLinkCapabilities {
  /** The provider yields OAuth tokens worth sealing. Steam: false/absent. */
  tokens?: boolean;
  /** PKCE on the authorize + exchange legs. */
  pkce?: boolean;
}

// ---------------------------------------------------------------------------
// Flow arguments
// ---------------------------------------------------------------------------

export interface AuthorizeUrlArgs {
  /** The signed state token minted by the engine. Opaque to the provider. */
  state: string;
  /** Byte-exact redirect the exchange must repeat. */
  redirectUri: string;
  /** Present iff `capabilities.pkce`. */
  codeChallenge?: string;
}

export interface HandleCallbackArgs {
  /** Raw callback query params, already string-valued. */
  query: Record<string, string>;
  redirectUri: string;
  codeVerifier?: string;
  /** Injected for testability; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

export interface AccountSyncArgs {
  providerUserId: string;
  tokens?: LinkTokens;
  fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------
// AccountLinkProvider contract (the entire provider surface)
// ---------------------------------------------------------------------------

/**
 * The contract every account-link provider implements (Steam, Twitch, or a
 * third party's own in their own repo). Types and pure functions only: no DB,
 * no engine import, so `@hogsend/core` alone is enough to author one.
 *
 * The provider owns exactly two wires — build the authorize URL, and turn a
 * callback into a proven {@link LinkedIdentity}. Everything stateful (the state
 * token, the contact resolve, the link store, versioning, hooks, outbound
 * events) lives in the engine and is deliberately not expressible here.
 */
export interface AccountLinkProvider {
  readonly meta: AccountLinkMeta;
  readonly capabilities?: AccountLinkCapabilities;
  /** Default `true`. `false` = one live link per contact for this provider. */
  readonly multiple?: boolean;
  /**
   * What to do when a DIFFERENT contact already owns the platform account.
   * Only legal when `multiple === false`; default `"replace"`. Upsert
   * vocabulary on purpose — `cardinality` is jargon that does not earn its
   * keep.
   */
  readonly onConflict?: "replace" | "reject";

  /** Where to send the player. The engine 302s to this; callers never see it. */
  authorizeUrl(args: AuthorizeUrlArgs): string | Promise<string>;

  /**
   * Turn the callback into a PROVEN identity, or throw
   * {@link AccountLinkCallbackError}. This is the only proof-of-control step in
   * the whole feature, so it must verify with the platform rather than trust
   * the callback's own parameters.
   */
  handleCallback(args: HandleCallbackArgs): Promise<LinkedIdentity>;

  /** Legal only under `capabilities.tokens` — nothing else holds a grant. */
  refresh?(tokens: LinkTokens, fetchImpl?: typeof fetch): Promise<LinkTokens>;
  /** Best-effort revoke on unlink. Legal only under `capabilities.tokens`. */
  revoke?(tokens: LinkTokens, fetchImpl?: typeof fetch): Promise<void>;

  /**
   * Opt-in periodic property refresh.
   *
   * Named `sync`, NOT `enrichment`. `enrichment` is a saturated term in this
   * repo: there is a whole unrelated subsystem meaning "buy B2B firmographic
   * data from a vendor" (`EnrichmentProvider`,
   * `engine/src/lib/enrichment-provider-registry.ts`, `enrichment-ledger.ts`,
   * `refineContact()`, the `ENRICHMENT_*` env vars, and a top-level
   * `createHogsendClient({ enrichment })` option). This field means "re-read a
   * platform's own API for an account we already own". Different thing, same
   * word — the same collision test that killed `defineLinkProvider`.
   */
  readonly sync?: {
    /**
     * MINIMUM AGE before a row is re-read, as a {@link DurationObject}
     * (`hours(24)`), NOT a cron string. There is ONE cron for every provider
     * and it ticks on its own cadence, so this value is read PER ROW in the
     * scan predicate `WHERE synced_at < now() - :every`. A cron STRING would
     * need a cron parser this repo does not have and does not otherwise need,
     * to express what `hours(24)` already says.
     */
    every: DurationObject;
    read(
      args: AccountSyncArgs,
    ): Promise<Record<string, string | number | boolean>>;
  };
}

// ---------------------------------------------------------------------------
// Callback failure
// ---------------------------------------------------------------------------

/**
 * The one error a `handleCallback` (or a token refresh) throws. `reason` is
 * deliberately the same three strings the `account.link_failed` outbound
 * payload uses, minus `"vetoed"` which only the hook path can produce — so the
 * callback route maps `err.reason` straight onto the event with no translation
 * table and no chance of drift.
 *
 * A message here is user-visible in logs, so a provider must NEVER interpolate
 * a raw response body into it: an OAuth error body can carry a token.
 */
export class AccountLinkCallbackError extends Error {
  readonly reason: "denied" | "exchange_failed" | "state_invalid";

  constructor(
    reason: "denied" | "exchange_failed" | "state_invalid",
    message: string,
  ) {
    super(message);
    this.name = "AccountLinkCallbackError";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Authoring constraints
// ---------------------------------------------------------------------------

/**
 * Ids that a provider may not take. The first six would shadow a literal
 * segment under `/v1/accounts/*` (`/me`, `/import`, `/link-url`, `/manage`,
 * and the `:provider/callback` + `:provider/start` legs), where this repo's
 * committed routing law is literal-before-param — a provider named `me` would
 * make `GET /v1/accounts/me` ambiguous. `email` and `sms` are already reserved
 * connector / webhook-source ids elsewhere in the repo, and one reserved-word
 * list per repo beats two that disagree.
 */
export const RESERVED_ACCOUNT_LINK_IDS = [
  "me",
  "import",
  "link-url",
  "manage",
  "callback",
  "start",
  "email",
  "sms",
] as const;

/**
 * A provider id is a URL path segment and a DB discriminator, so it is
 * lowercase, starts with a letter, and stays short enough to read in a route.
 */
export const ACCOUNT_LINK_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Identity factory for an {@link AccountLinkProvider}. Mirrors
 * `defineEmailProvider` / `defineSmsProvider` — returns its argument unchanged
 * but pins the literal shape to the contract, so a typo in `meta` or a missing
 * method is caught at definition time.
 *
 * The guards below are cheap and run at module load, where a misconfiguration
 * is a developer's problem rather than a player's failed link at 3am.
 */
export function defineAccountLink(
  provider: AccountLinkProvider,
): AccountLinkProvider {
  const id = provider.meta?.id;

  if (!ACCOUNT_LINK_ID_RE.test(id)) {
    throw new Error(
      `account link provider id "${id}" is invalid — it must match ` +
        `${ACCOUNT_LINK_ID_RE.source} (lowercase, letter-first, max 32 chars), ` +
        "because the id is the `:provider` path segment and a DB discriminator",
    );
  }

  if ((RESERVED_ACCOUNT_LINK_IDS as readonly string[]).includes(id)) {
    throw new Error(
      `account link provider id "${id}" is reserved — it would shadow a route ` +
        "segment under /v1/accounts/* or an existing connector id. Pick " +
        "another id (e.g. the platform's own name)",
    );
  }

  // `onConflict` decides who wins when a platform account is contested, which
  // can only happen when a contact is limited to ONE live link. Under the
  // default `multiple: true` there is nothing to contest, so an author who set
  // it believes a policy is in force that is not.
  if (provider.onConflict !== undefined && provider.multiple !== false) {
    throw new Error(
      `account link provider "${id}" sets onConflict but not multiple: false — ` +
        "onConflict is only meaningful for a one-per-contact provider. Set " +
        "`multiple: false`, or drop `onConflict`",
    );
  }

  // A provider that holds no grant has nothing to refresh or revoke, so these
  // functions could only ever be dead code — or worse, a signal that the author
  // expected tokens to be sealed and they never were.
  if (provider.refresh && provider.capabilities?.tokens !== true) {
    throw new Error(
      `account link provider "${id}" declares refresh() without ` +
        "`capabilities.tokens: true` — a provider that stores no tokens has " +
        "nothing to refresh",
    );
  }

  if (provider.revoke && provider.capabilities?.tokens !== true) {
    throw new Error(
      `account link provider "${id}" declares revoke() without ` +
        "`capabilities.tokens: true` — a provider that stores no tokens has " +
        "nothing to revoke",
    );
  }

  if (provider.sync) {
    // A zero or negative minimum age makes the cron's
    // `WHERE synced_at < now() - :every` predicate match EVERY row on EVERY
    // tick — a stampede against the platform's API, not a configuration.
    if (!(durationToMs(provider.sync.every) > 0)) {
      throw new Error(
        `account link provider "${id}" declares sync.every as a non-positive ` +
          "duration — it is the MINIMUM AGE before a row is re-read, so a " +
          "zero/negative value re-reads every row on every cron tick. Use " +
          "e.g. hours(24)",
      );
    }
    if (typeof provider.sync.read !== "function") {
      throw new Error(
        `account link provider "${id}" declares sync without a read() ` +
          "function — sync exists to re-read the platform, so there is " +
          "nothing to run",
      );
    }
  }

  return provider;
}

// ---------------------------------------------------------------------------
// Hooks — the IN-PROCESS plane
//
// Three planes reach a consumer and each does a job the other two cannot: the
// PULL plane (`/v1/accounts/*`) is authoritative, the PUSH plane (outbound
// webhooks) is the at-least-once mirror feed, and these hooks are the only
// place a VETO can live and the only place an in-band write to the consumer's
// own database can happen. They are NOT a delivery mechanism.
// ---------------------------------------------------------------------------

/**
 * What `beforeLink` sees. Built by the engine AFTER the provider has proven
 * control of the platform account and BEFORE anything is written.
 *
 * `userId` and `email` are NOT looked up by the hook runner: the store reads
 * them via a join to `contacts` inside the same advisory-locked transaction and
 * hands them over, so nothing re-reads the database at hook time.
 */
export interface BeforeLinkContext {
  provider: string;
  /** The identity the provider PROVED. A reported email is never a key. */
  identity: LinkedIdentity;
  /**
   * NULL on the COLD path, where no contact exists yet.
   *
   * This is `string | null`, not `string`, because `beforeLink` runs strictly
   * BEFORE any write and is FAIL-CLOSED. On the cold path (`/start` with an
   * `anonymous_id`) the contact has not been resolved yet, so a required
   * `string` could only be satisfied by minting the contact before the veto —
   * which leaves a ghost contact behind every rejected link and puts a write in
   * front of a security hook — or by passing a placeholder, which lies to that
   * hook. Both are worse than a nullable field. A hook that wants to refuse
   * anonymous links refuses on `contactId === null`.
   */
  contactId: string | null;
  /**
   * The browser anonymous key the cold path is binding to. Set iff
   * `contactId === null`. Exactly one of the two is present.
   */
  anonymousId?: string;
  /**
   * The canonical contact key `contactKey()`
   * (`external_id ?? anonymous_id ?? id`). Null on the cold path. This is the
   * SAME definition the outbound payloads and the SDK use for `userId` — never
   * a raw `externalId` — so a consumer can join the PULL, PUSH and IN-PROCESS
   * planes on one value.
   */
  userId: string | null;
  /** The contact's OWN email, null when it has none. Never the provider's. */
  email: string | null;
  /**
   * Set when a DIFFERENT contact currently owns this platform account, so a
   * hook can refuse a takeover its own product rules forbid.
   */
  currentOwnerContactId?: string;
}

/**
 * An EXPLICIT verdict from `beforeLink`. `allow: false` rejects the link and
 * `reason` is recorded with the failure; it is operator-facing, so it must not
 * carry a token or anything else secret.
 */
export interface BeforeLinkVerdict {
  allow: boolean;
  reason?: string;
}

/**
 * What `beforeLink` may return.
 *
 * **A `void` / `undefined` return means ALLOW.** The hook ran to completion and
 * raised no objection, which is the only reading that lets a side-effect-only
 * hook (log a row, warm a cache) exist without accidentally vetoing every link.
 * Denial is therefore never implicit: it is either an EXPLICIT
 * `{ allow: false }` or a FAILURE (a throw, or exceeding
 * {@link ACCOUNT_LINK_HOOK_TIMEOUT_MS}). Fail-closed lives on the failure
 * channel, not on the success channel, so neither `undefined` nor a forgotten
 * `return` can silently flip a decision in either direction.
 *
 * The `void` arm is load-bearing and `undefined` cannot replace it: TypeScript
 * does not accept a `() => void` where `() => undefined` is required, so a hook
 * written as `beforeLink: () => { log(ctx); }` would stop compiling and every
 * side-effect-only veto hook would have to write an explicit `return undefined`.
 */
export type BeforeLinkResult =
  | BeforeLinkVerdict
  // biome-ignore lint/suspicious/noConfusingVoidType: see the note above — a `() => void` hook must be assignable here.
  | void;

/** What `afterLink` sees. Post-commit, so the link row exists and is durable. */
export interface AfterLinkContext extends BeforeLinkContext {
  /** Post-commit, so the contact is always resolved by now. */
  contactId: string;
  method: "oauth" | "import";
  /** True when this link MOVED the platform account off another contact. */
  relink: boolean;
  /**
   * The `linked_accounts.version` bigint, as a STRING. It exceeds
   * `Number.MAX_SAFE_INTEGER`, so it is NEVER a JS `number` and never arrives
   * via `parseInt` — a silently-rounded version breaks the consumer's
   * `incoming > stored` guard in exactly the case that guard exists for. A hook
   * comparing versions compares them as `BigInt(a) > BigInt(b)`.
   */
  version: string;
  /** ISO 8601 with offset. */
  at: string;
}

/**
 * What `afterUnlink` sees. Deliberately NOT an extension of
 * {@link BeforeLinkContext}: an unlink proves nothing about a platform account,
 * so there is no {@link LinkedIdentity} to carry — only the pair that was
 * unlinked.
 */
export interface AfterUnlinkContext {
  provider: string;
  providerUserId: string;
  contactId: string;
  /** `contactKey()`, same definition as {@link BeforeLinkContext.userId}. */
  userId: string | null;
  /** The contact's own email, null when it has none. */
  email: string | null;
  /**
   * Why the link went away. `"relinked"` is the second half of a move: the
   * platform account was taken by another contact, and this fires with the
   * `"linked"` for the new owner.
   */
  reason: "player" | "api" | "relinked";
  /** Bigint version as a STRING, exactly as on {@link AfterLinkContext}. */
  version: string;
  /** ISO 8601 with offset. */
  at: string;
}

/**
 * POSTURES — these are contract, not implementation detail:
 *
 * - `beforeLink` is BLOCKING, bounded by {@link ACCOUNT_LINK_HOOK_TIMEOUT_MS},
 *   and FAIL-CLOSED. A throw, a timeout, or an explicit `{ allow: false }` all
 *   reject the link. A veto hook that fails open is not a veto hook. Returning
 *   nothing ALLOWS — see {@link BeforeLinkResult}.
 * - `afterLink` / `afterUnlink` run POST-COMMIT, are AT-LEAST-ONCE (so they
 *   must be idempotent), are FAIL-OPEN, and are bounded by the same 5s. A throw
 *   is LOGGED and NEVER unwinds the link — the row is already committed — and a
 *   timeout does not stop the success page rendering. `afterLink` runs BEFORE
 *   that page renders (bounded) so "you now have your reward" is true when the
 *   player reads it.
 *
 * These are IN-PROCESS hooks, NOT a delivery mechanism: a throw does not retry,
 * and a process that dies mid-hook simply loses the call. Anything that must
 * not be missed belongs on the outbound webhooks (retried, deduped) or on a
 * pull reconcile against `/v1/accounts/*`, which is authoritative.
 *
 * There is exactly ONE invoker — the link store, post-commit — so no route,
 * page or SDK path may also call them, or every hook would fire twice.
 * `beforeLink` is the callback's, pre-write.
 */
export interface AccountLinkHooks {
  beforeLink?(
    ctx: BeforeLinkContext,
  ): Promise<BeforeLinkResult> | BeforeLinkResult;
  afterLink?(ctx: AfterLinkContext): Promise<void> | void;
  afterUnlink?(ctx: AfterUnlinkContext): Promise<void> | void;
}

/**
 * The single bound every hook runs under, in the zero-dependency package so the
 * engine and the docs quote ONE number rather than drifting apart.
 */
export const ACCOUNT_LINK_HOOK_TIMEOUT_MS = 5_000;
