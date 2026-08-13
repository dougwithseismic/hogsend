# PRD 12 — Server SDK `accounts.*`

## Goal

Add the `accounts` resource to `@hogsend/client` so a customer reconciles the pull plane from their
own backend in typed TypeScript instead of hand-rolled `fetch`. Mirrors `groups.ts` exactly: same
resource class shape, same registration on `Hogsend`, same type-export discipline, same test
conventions.

## Locked decisions specific to this PRD

- `@hogsend/client` owns the `accounts.*` server SDK resource (DECISIONS §3.1).
- `packages/client/src/resources/groups.ts` is the template (DECISIONS §3.3, last-but-one row).
- The pull plane is AUTHORITATIVE (DECISIONS §3.2). The SDK is a thin typed wrapper over
  `/v1/accounts/*`; it caches nothing, retries nothing beyond the existing `HttpClient`, and holds no
  local view of link state.
- The mint helper is named `mintAccountLinkUrl` (DECISIONS §2), never `mintLink` — `links.mintLink`
  already exists on this same client (`packages/client/src/resources/links.ts`), so the two must not
  be confusable at the call site.
- Import is INSERT-ONLY and returns `{ inserted, conflicts }` (DECISIONS §6.2). The SDK surfaces that
  shape verbatim; it does not smooth conflicts away into a boolean.
- `@hogsend/client` is secret-key only. There is no `me` or `link-url` binding here — those are the
  browser routes and belong to PRD 13's `@hogsend/js`.

## Grounding in the real tree

- `packages/client/src/resources/groups.ts` — the exact shape to mirror: a class taking
  `private readonly http: HttpClient` (`:25`), one method per route, `encodeURIComponent` on every
  path segment (`:48-51`, `:72-76`, `:87-90`), an unwrapping `async` method where the server nests
  the payload (`:32-40`) and a pass-through `Promise` return where it does not (`:70-77`).
- `packages/client/src/hogsend.ts` — resource declaration with a doc comment naming the auth tier
  (`:28-35` for groups), and construction in the constructor (`:80`).
- `packages/client/src/types.ts` — the type block per resource: a row interface, then one `…Input`
  interface per method, each with a one-line doc (`:200-270` for groups).
- `packages/client/src/index.ts` — the flat, alphabetized `export type { … } from "./types.js"` list.
  Every new public type must be added there or it is unusable by a consumer.
- `packages/client/src/internal/http.ts:27-53` — `HttpClient`: `get(path, query)`, `post(path, body)`,
  `del(path, body?)`. `del` accepts an optional body; the accounts unlink does not need one (the pair
  is in the path).
- `packages/client/src/__tests__/hogsend.test.ts` — the harness. `makeFetch` at `:29` records
  `{ url, method, headers, body }`; `describe("groups")` at `:398` is the block to copy in shape and
  in assertion style (assert the URL, the method AND the body, not just the return value).
- `packages/client/src/types.ts:496-520` — the vendored `OutboundEventType` union, hand-synced with
  the engine's `WEBHOOK_EVENT_TYPES` (`packages/engine/src/lib/webhook-signing.ts:57`). See
  `## Seams` for the sequencing rule.

## Acceptance criteria (EARS)

- WHEN a consumer constructs `new Hogsend({ baseUrl, apiKey })`, the system SHALL expose an
  `accounts` resource alongside `groups`, `flags`, `webhooks` and `links`.
- WHEN `accounts.list({ contactId })` is called, the SDK SHALL issue `GET /v1/accounts?contactId=…`
  and SHALL return the unwrapped `LinkedAccount[]`.
- WHEN `accounts.list({ email })` or `accounts.list({ provider, limit, offset })` is called, the SDK
  SHALL forward exactly those query parameters and SHALL omit undefined ones.
- WHEN `accounts.get({ provider, providerUserId })` is called, the SDK SHALL issue
  `GET /v1/accounts/<provider>/<providerUserId>` with BOTH segments `encodeURIComponent`-encoded,
  and SHALL return the unwrapped `LinkedAccount`.
- WHEN `accounts.get` addresses a pair with no live link, the SDK SHALL throw `HogsendAPIError` with
  `status === 404` (the existing error mapping; no special-casing).
- WHEN `accounts.unlink({ provider, providerUserId })` is called, the SDK SHALL issue
  `DELETE /v1/accounts/<provider>/<providerUserId>` with encoded segments and SHALL return
  `{ unlinked, version? }`.
- WHEN `accounts.import({ rows })` is called, the SDK SHALL issue `POST /v1/accounts/import` and
  SHALL return `{ inserted, conflicts }` unmodified. It SHALL NOT throw on a non-empty `conflicts`
  array — a partially conflicting batch is a `200`, and the caller decides.
- WHEN `accounts.mintAccountLinkUrl({ provider, contactId })` is called, the SDK SHALL issue
  `POST /v1/accounts/mint-link` and SHALL return `{ url, expiresAt }`.
- WHEN `accounts.mintAccountLinkUrl` is called with `{ provider, email }`, the SDK SHALL forward
  `email` instead of `contactId`; the input type SHALL require exactly one of the two at the type
  level, in the style of the existing `Identity` union (`packages/client/src/types.ts:39-41`).
- WHEN the SDK is bundled, it SHALL NOT expose any binding for `GET /v1/accounts/me` or
  `POST /v1/accounts/link-url`. Those are userToken-gated browser routes; a server SDK carrying them
  invites a customer to proxy a userToken through their backend for no reason.
- WHEN a new public type is added by this PRD, it SHALL appear in the `export type { … }` list in
  `packages/client/src/index.ts`.
- WHEN this PRD is implemented, it SHALL NOT edit the `OutboundEventType` union in
  `packages/client/src/types.ts` — PRD 08 owns that union's three new `account.*` members.

## Tasks

### T1 — Types
_Boundary:_ `packages/client`
_Depends:_ —

Add to `packages/client/src/types.ts`, in a section headed like the groups block at `:196-200`:

```ts
/** A linked platform account as returned by `/v1/accounts` (list / get). */
export interface LinkedAccount {
  provider: string;
  providerUserId: string;
  contactId: string;
  username: string | null;
  avatarUrl: string | null;
  /** How the link was established. `"import"` rows never displaced a live owner. */
  method: "oauth" | "import";
  /**
   * Monotonic per `(provider, providerUserId)` across live AND unlinked rows.
   * THE reconciliation guard: upsert keyed on `(provider, providerUserId)` and
   * apply only when `incoming.version > stored.version`, else discard. Never use
   * a timestamp as a tiebreaker.
   *
   * A decimal STRING, not a number (DECISIONS §5.1): the column is a Postgres
   * `bigint` and exceeds `Number.MAX_SAFE_INTEGER`. Compare with `BigInt(a) >
   * BigInt(b)` or store it in a numeric column; `parseInt` rounds it and breaks
   * the guard in exactly the case the guard exists for. Same representation on
   * the pull plane (PRD 09), the push plane (PRD 08) and the hooks (PRD 01).
   */
  version: string;
  /** ISO string. */
  linkedAt: string;
  /**
   * ISO string when the provider revoked the stored tokens. The LINK survives a
   * token revocation; only the property sync stops. Null when tokens are live or the
   * provider stores none (Steam).
   */
  tokensRevokedAt: string | null;
}

/** Input to `accounts.list`. At least one of `contactId` / `email` / `provider`. */
export type ListAccountsInput =
  | { contactId: string; provider?: string; limit?: number; offset?: number }
  | { email: string; provider?: string; limit?: number; offset?: number }
  | { provider: string; limit?: number; offset?: number };

/** Input to `accounts.get` and `accounts.unlink` — the platform-account natural key. */
export interface AccountKeyInput {
  provider: string;
  providerUserId: string;
}

/** Result of `accounts.unlink`. `unlinked` is false when no live link existed. */
export interface UnlinkAccountResult {
  unlinked: boolean;
  /** The version allocated by this unlink, as a decimal string. Absent when
   * nothing was unlinked. */
  version?: string;
}

/** One row of an `accounts.import` batch. Exactly one of `contactId` / `email`. */
export interface ImportAccountRow {
  provider: string;
  providerUserId: string;
  contactId?: string;
  email?: string;
  username?: string;
  avatarUrl?: string;
  /** ISO string. Preserves the historical link date from the customer's own system. */
  linkedAt?: string;
}

/** Input to `accounts.import`. Max 1000 rows per call. */
export interface ImportAccountsInput {
  rows: ImportAccountRow[];
}

/** A row the import refused. The existing live link was left completely untouched. */
export interface ImportAccountConflict {
  provider: string;
  providerUserId: string;
  reason: "already_linked" | "singleton_conflict" | "unknown_contact";
  /** The live owner, when there is one. */
  ownerContactId?: string;
}

/**
 * Result of `accounts.import`. INSERT-ONLY: a row whose `(provider, providerUserId)`
 * already has a live owner is reported in `conflicts` and changes nothing. Only a
 * completed hosted link callback can move a link between contacts.
 */
export interface ImportAccountsResult {
  inserted: number;
  conflicts: ImportAccountConflict[];
}

/** Input to `accounts.mintAccountLinkUrl`. Exactly one of `contactId` / `email`. */
export type MintAccountLinkUrlInput =
  | { provider: string; contactId: string; returnTo?: string }
  | { provider: string; email: string; returnTo?: string };

/** Result of `accounts.mintAccountLinkUrl`. */
export interface AccountLinkUrl {
  /**
   * An ENGINE-origin URL: `<API_PUBLIC_URL>/v1/accounts/<provider>/start?t=<state>`
   * (DECISIONS §15.2). Never the platform's own authorize URL — that is only ever
   * a 302 target the engine issues, never a value handed to a caller. Send the
   * player here (a redirect, a button href, a DM link) and the engine handles the
   * rest of the handshake.
   */
  url: string;
  /** ISO string. Short-lived; mint on demand rather than caching. */
  expiresAt: string;
}
```

Add every one of these names to the `export type { … }` list in `packages/client/src/index.ts`,
alphabetized into the existing block.

### T2 — The resource
_Boundary:_ `packages/client`
_Depends:_ T1

`packages/client/src/resources/accounts.ts`, structurally identical to `groups.ts`:

```ts
export class AccountsResource {
  constructor(private readonly http: HttpClient) {}

  async list(input: ListAccountsInput): Promise<LinkedAccount[]>;
  async get(input: AccountKeyInput): Promise<LinkedAccount>;
  unlink(input: AccountKeyInput): Promise<UnlinkAccountResult>;
  import(input: ImportAccountsInput): Promise<ImportAccountsResult>;
  mintAccountLinkUrl(input: MintAccountLinkUrlInput): Promise<AccountLinkUrl>;
}
```

Rules carried over from `groups.ts`:
- Every path segment through `encodeURIComponent` (`groups.ts:48-51`) — a Steam id is numeric but a
  Twitch id and any third-party provider id are not guaranteed to be URL-safe, and a third-party
  `defineAccountLink` may use anything.
- `list` and `get` are `async` and unwrap the server's `{ accounts }` / `{ account }` envelope;
  `unlink`, `import` and `mintAccountLinkUrl` return the `Promise` directly (the server response IS
  the result shape).
- `import` is a reserved word as a bare identifier but is legal as a class method name and as
  `hs.accounts.import(...)`. Keep the name — it matches the route and reads correctly. Verify Biome
  is happy with it under the repo config; if it objects, the fix is a Biome exception, not a rename
  that diverges from the route.
- The class doc comment states the auth tier and the insert-only invariant, in the register of
  `groups.ts:15-23`.

### T3 — Register on the client
_Boundary:_ `packages/client`
_Depends:_ T2

In `packages/client/src/hogsend.ts`: import `AccountsResource`, declare
`readonly accounts: AccountsResource;` with a doc comment in the shape of the groups one (`:28-35`)
naming the secret-key-only tier and the `accounts` scope, and construct it in the constructor
alongside `this.groups = new GroupsResource(http);` (`:80`).

### T4 — Tests
_Boundary:_ `packages/client`
_Depends:_ T3

Add a `describe("accounts", …)` block to `packages/client/src/__tests__/hogsend.test.ts`, placed
after `describe("groups")` (`:398`) and using the existing `makeFetch` / `client` helpers. Every test
asserts the recorded URL, the method AND the body, matching the groups block's style:

- `list by contactId hits GET /v1/accounts with the contactId query`
- `list by email forwards email and omits undefined params`
- `list by provider forwards limit and offset`
- `get encodes both path segments`
- `get throws HogsendAPIError with status 404 for an unknown pair`
- `unlink issues DELETE with encoded segments and returns the version`
- `version is typed and returned as a string` — assert `typeof row.version === "string"` on a stubbed
  response, and that a version above `Number.MAX_SAFE_INTEGER` (`"9007199254740993"`) survives the
  parse untouched. A type test alone would not catch a `Number()` in the response mapper.
- `unlink returns unlinked:false without throwing`
- `import posts the batch and returns inserted plus conflicts verbatim`
- `import does not throw when conflicts is non-empty`
- `mintAccountLinkUrl posts contactId`
- `mintAccountLinkUrl posts email`
- `the client exposes no me or link-url binding` — assert
  `"me" in client.accounts === false` and `"mintUserLinkUrl" in client.accounts === false`, pinning
  DECISIONS §6.5 at the SDK boundary.

### T5 — README + changeset
_Boundary:_ `packages/client`
_Depends:_ T4

Add an `accounts` section to `packages/client/README.md` beside the groups section, and state the
reconciliation rule VERBATIM as DECISIONS §5.3 requires:

> Upsert keyed on `(provider, providerUserId)`; apply only when `incoming.version > stored.version`;
> otherwise discard.

State immediately after it that `version` is a decimal STRING for a `bigint` column, so the
comparison is `BigInt(incoming.version) > BigInt(stored.version)` (or a numeric column in the
consumer's own DB), never `parseInt` (DECISIONS §5.1).

Minor changeset for `@hogsend/client`.

## Seams

**Sequencing, not an external dependency.** `packages/client/src/types.ts` also holds the vendored
`OutboundEventType` union (`:496-520`), which PRD 08 edits to add `account.linked`,
`account.unlinked` and `account.link_failed` — one of the three hand-synced catalog copies named in
DECISIONS §8. This PRD adds a NEW type block to the same file and must not touch that union. If PRD
08 and PRD 12 are worked concurrently the two edits land in the same file and will conflict at the
patch level; the resolution is trivial (different regions), but the rule is: **PRD 08 owns
`OutboundEventType`, PRD 12 owns everything else it adds to `types.ts`.** Preference is to land PRD
08 first.

No external dependency, no human ask.

## Done when

- [ ] `hs.accounts.{list,get,unlink,import,mintAccountLinkUrl}` exist and are typed.
- [ ] Every new type is exported from `packages/client/src/index.ts`.
- [ ] The `describe("accounts")` block is green, including the "no browser bindings" assertion.
- [ ] `OutboundEventType` is untouched by this PRD's diff (`git diff` shows no change in that region).
- [ ] README carries the verbatim reconciliation rule.
- [ ] Changeset added for `@hogsend/client`.
- [ ] From the worktree root (DECISIONS §4):
      ```
      pnpm lint
      pnpm check-types
      cd apps/api && pnpm test
      ```
- [ ] Public-surface change, so also: `pnpm build`.

## Implementation Notes
