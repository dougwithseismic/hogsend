# PRD 14 — Token custody + property sync cron

## Goal

Hold a linked account's OAuth tokens sealed per contact, refresh them, best-effort revoke them on
unlink, and run ONE Hatchet cron that walks providers opting into property sync and writes namespaced
flat scalars onto `contacts.properties` so journeys and buckets read them with zero new machinery.
Steam proves the token-free path: playtime and ownership are a public Web API read keyed by
steamid64, so it stores nothing.

## Locked decisions specific to this PRD

- **Seal with the existing AES-256-GCM helper into `linked_accounts.tokens`, only for providers
  declaring token use. Steam stores nothing** (DECISIONS §10, §3.3).
- **`refresh()` wire on the provider; best-effort `revoke()` on unlink** (DECISIONS §10).
- **Per-provider opt-in `sync: { every: Duration, read() }`, run by ONE Hatchet cron, writing
  namespaced scalars onto `contacts.properties` (`steam_playtime_2wk`, `twitch_follower_count`)**
  (DECISIONS §10).
- **The field is `sync`, NOT `enrichment`** (DECISIONS §10). `enrichment` is already a saturated
  term here: `@hogsend/engine` ships an entire unrelated **enrichment** subsystem meaning "buy B2B
  firmographic data about a person from a vendor" — the `EnrichmentProvider` contract,
  `EnrichmentProviderRegistry` (`packages/engine/src/lib/enrichment-provider-registry.ts`), the
  paid-lookup ledger (`packages/engine/src/lib/enrichment-ledger.ts`, table `enrichment_lookups`),
  `refineContact()` (`packages/engine/src/lib/refine.ts`), the `ENRICHMENT_PROVIDER` /
  `ENRICHMENT_TTL_DAYS` / `ENRICHMENT_MONTHLY_LOOKUPS` env vars (`packages/engine/src/env.ts:216-228`)
  and a top-level `createHogsendClient({ enrichment })` option (`container.ts:483`, resolved at
  `:1290-1296`). This PRD's field means "re-read a platform's own API for an account we already
  own". Same word, different thing, and DECISIONS §2 killed `defineLinkProvider` on exactly this
  test. **Do NOT rename or otherwise touch the pre-existing enrichment subsystem**: it keeps its
  name, and every new name in this PRD (columns, cron, env var, exported functions) uses `sync`.
- **`every` is a `Duration`, not a cron string** (DECISIONS §10). It expresses the MINIMUM AGE
  before a row is re-read, so the ONE cron's `WHERE synced_at < now() - :every` predicate reads it
  per row with NO cron parser. This repo has no cron parser and needs none: a per-provider cron
  STRING would have to be parsed and evaluated in application code to answer "is this provider
  due?", to express what `hours(24)` already says. The concrete type is `DurationObject`
  (`packages/core/src/duration.ts`), built with `days()` / `hours()` / `minutes()` and converted
  with `durationToMs()`.
- **Provider-side revocation (`invalid_grant`) keeps the link and kills the property sync**: set
  `tokens_revoked_at`, null the blob, skip in future cron runs, expose the field on the pull plane.
  **Do NOT auto-unlink** (DECISIONS §10). The link is an identity claim proven once; the token is
  plumbing, and refresh tokens die from password changes as often as from intent.
- **No `account.updated` outbound event** (DECISIONS §8, §12). A customer who cares about token
  revocation reads `tokensRevokedAt` from the pull plane.
- The three outbound events stay exactly three (DECISIONS §8). This PRD adds none.
- Providers are NOT plugin packages (DECISIONS §3.1); the concrete Steam and Twitch definitions live
  in `@hogsend/engine` and are PRD 06's. Discord is out of v1 (DECISIONS §12) and has no
  account-link provider to sync.
- **`account.synced` is an INGEST-ONLY event name, and it is not a fourth outbound event.** Making a
  synced fact visible to buckets requires going through `ingestEvent`, which requires an event NAME
  (`apps/api/src/workflows/gtm-score.ts:386-390`). So this PRD writes `account.synced` to
  `user_events` to drive bucket re-evaluation, and deliberately does NOT append it to
  `WEBHOOK_EVENT_TYPES` (`packages/engine/src/lib/webhook-signing.ts:57`) or to either vendored
  catalog copy. No customer webhook ever sees it, and DECISIONS §8's count of exactly three outbound
  events stands. The alternative, a direct `contacts` UPDATE, is worse and is rejected explicitly: it
  leaves any bucket keyed on `steam_playtime_2wk` permanently stale, because `bucket-reconcile` only
  sweeps time-based criteria. Stated here so a reviewer does not read `account.synced` as a fourth
  event.

## Acceptance criteria (EARS)

- WHEN a provider declares no token use the system SHALL write nothing to `linked_accounts.tokens`
  and SHALL still run that provider's `sync` if it declares one.
- WHEN tokens are stored the system SHALL seal them AES-256-GCM at rest and SHALL NEVER return the
  decrypted blob from any HTTP response, mirroring the invariant at
  `packages/engine/src/routes/admin/provider-credentials.ts:18-22`.
- WHEN an access token has less than `EXPIRY_SKEW_MS` (60s) of life remaining the system SHALL
  refresh it before use.
- WHEN a refresh response omits `refresh_token` the system SHALL keep the stored one, matching the
  rotation rule at `packages/engine/src/lib/oauth-token-manager.ts:180-186`.
- WHEN a refresh fails with an OAuth `error` of `invalid_grant` (or a 400 whose body names it) the
  system SHALL set `tokens_revoked_at = now()`, set `tokens = NULL`, leave the link row LIVE, and
  skip that row in every future cron run. It SHALL NOT unlink and SHALL NOT emit an outbound event.
- WHEN a refresh fails for any OTHER reason (5xx, timeout, network) the system SHALL treat it as
  transient: increment `sync_failures`, set `sync_next_at` to a jittered exponential backoff,
  and leave `tokens` intact.
- WHEN the sync cron ticks the system SHALL process each opted-in provider whose rows are
  due, and SHALL NOT process a row whose `synced_at` is newer than the provider's declared
  `sync.every` minimum age, nor one with `tokens_revoked_at IS NOT NULL`, nor one with
  `sync_next_at > now()`, nor an unlinked one.
- WHEN the cron reads rows the system SHALL page with a keyset cursor in bounded batches and SHALL
  pause between batches, so a publisher with millions of links cannot load them all into memory.
- WHEN the cron calls a provider the system SHALL cap in-flight calls per provider and SHALL pace
  them to the provider's declared rate limit, so one tick cannot stampede the provider.
- WHEN a run overruns its interval the next tick SHALL QUEUE behind it rather than cancel it, using
  `ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN` with `maxRuns: 1` on a single static key.
- WHEN a sync read produces facts the system SHALL write them **through `ingestEvent` with
  `contactProperties`**, never a direct `contacts` UPDATE, because `ingestEvent` is the only write
  path that re-runs `checkBucketMembership` (see `apps/api/src/workflows/gtm-score.ts:386-390`).
- WHEN a sync read produces facts the keys SHALL be **flat, top-level, namespaced strings** carrying
  real JSON scalars (`steam_playtime_2wk: 412`, not `steam: { playtime_2wk: 412 }`), because
  `evaluatePropertyConditions` does a flat lookup with no dotted-path traversal
  (`packages/core/src/conditions/property.ts:19`) and `compareValue` does no coercion
  (`packages/core/src/conditions/property.ts:24-71`).
- WHEN a provider does not KNOW a fact the system SHALL omit the key entirely, matching
  `packages/engine/src/lib/refine-traits.ts:52-55`. An explicit `null` is reserved for "this fact is
  no longer true", which `mergePropertiesSql`'s `jsonb_strip_nulls`
  (`packages/engine/src/lib/contacts.ts:782-796`) turns into a key REMOVAL. The two are different
  statements and PRD 01's fact type permits both.
- WHEN a link is unlinked the system SHALL call the provider's `revoke()` best-effort, SHALL swallow
  any failure with a warn log, and SHALL clear the stored blob regardless of the outcome.
- WHEN the worker process boots the cron SHALL be registered; the API process SHALL NOT run it.

## Tasks

### T1 — Property-sync columns on `linked_accounts`
_Boundary:_ `packages/db`
_Depends:_ PRD 02

Additive columns + the cron's scan index, in this PRD's OWN migration on top of PRD 02's. PRD 02
already ships `tokens` and `tokens_revoked_at` (DECISIONS §10 names both) and deliberately ships NO
sync bookkeeping, so this task adds exactly the three scheduling columns and the index. The
`synced_at` column belongs HERE, not in PRD 02: it is what `sync.every` is compared against, and
the two PRDs are independently shippable.

- `packages/db/src/schema/linked-accounts.ts`:
  - `tokens: text("tokens")` (nullable). **`text`, not `jsonb`**, deliberately mirroring
    `packages/db/src/schema/provider-credentials.ts:21` ("tokens are opaque at the database layer by
    design"). The value is `base64url(iv || ciphertext || tag)`, not JSON.
  - `tokensRevokedAt: timestamp("tokens_revoked_at", { withTimezone: true })`
  - `syncedAt: timestamp("synced_at", { withTimezone: true })`
  - `syncFailures: integer("sync_failures").notNull().default(0)`
  - `syncNextAt: timestamp("sync_next_at", { withTimezone: true })`
  - A partial index serving the cron's exact predicate:
    `index("linked_accounts_sync_due_idx").on(table.provider, table.syncedAt).where(sql\`unlinked_at IS NULL AND tokens_revoked_at IS NULL\`)`
- `cd packages/db && pnpm db:generate`, commit the generated migration.

### T2 — Rate-limit hint on the `sync` block
_Boundary:_ `packages/core`
_Depends:_ PRD 01

**PRD 01 already owns the whole contract.** `AccountLinkProvider` there carries top-level
`refresh?(tokens, fetchImpl)` / `revoke?(tokens, fetchImpl)`
(PRD 01 T1's `AccountLinkProvider`) and `sync?: { every: DurationObject, read }`,
and `oauth2Link()` already flags a dead grant with a boolean `invalidGrant` field on
`AccountLinkCallbackError` specifically so this PRD can branch without string-matching
(`:305-309`). Do not redefine any of that here. This task adds one field and nothing else.

- On PRD 01's `sync` block, add:
  ```ts
  /**
   * Rate-limit budget the ONE property-sync cron paces to. Defaults applied by
   * the cron: concurrency 4, minIntervalMs 250 (4 requests/sec).
   */
  readonly rateLimit?: { concurrency?: number; minIntervalMs?: number };
  ```
  Without it the cron has no per-provider budget to honour and the "must not stampede a provider's
  rate limit" requirement has nothing to read. Steam's documented budget (100k calls/day) and
  Twitch's Helix budget (a refilling 800-point bucket, effectively tens of requests per second)
  differ by orders of magnitude, so one hardcoded default cannot serve both.
- The block's doc comment must already carry PRD 01's "this is not `EnrichmentProvider`" line
  (DECISIONS §10). Confirm it is there rather than re-adding it, so a reader who arrives at
  `rateLimit` does not go looking for the firmographic-vendor subsystem.

Tests — extend PRD 01's `packages/core/src/providers/account-link.test.ts`:
- `"accepts a sync block with no rateLimit"`
- `"rejects a rateLimit with a non-positive concurrency"`

### T3 — Extract the AES-256-GCM sealer
_Boundary:_ `packages/engine`
_Depends:_ —

DECISIONS §3.3 says to reuse the sealer at `packages/engine/src/lib/provider-credentials.ts`. It
cannot be reused as-is: `encryptJson` (`:121`) and `decryptJson` (`:138`) are **private**, and the
key is `env.BETTER_AUTH_SECRET` hardcoded at four call sites (`:243`, `:263`, `:357`, `:370`). So
**generalize, do not copy**, a third private copy of an AES construction is how one of them drifts.

- New `packages/engine/src/lib/seal.ts` holding `IV_LENGTH`/`TAG_LENGTH`, `deriveKey`, and:
  ```ts
  export function sealJson(value: unknown, secret: string): string;
  export function unsealJson(blob: string, secret: string): unknown; // throws SealError
  export class SealError extends Error {}
  ```
- `provider-credentials.ts` imports them and keeps its own `ProviderCredentialDecryptError` wrapper
  (its message carries the `hogsend connect` remediation, which is provider-credential specific and
  must not leak into a per-contact path).
- Behaviour must be byte-identical: the same `base64url(iv(12) || ciphertext || tag(16))` layout, so
  every existing stored credential still decrypts.

Tests — `packages/engine/src/lib/seal.test.ts`:
- `"round-trips an object"`
- `"a blob sealed under one secret does not unseal under another"`
- `"rejects a truncated blob"`
- `"decrypts a fixture written by the pre-extraction code path"` (the anti-drift test; without it the
  refactor could silently change the layout and brick every live credential)

### T4 — Per-contact token custody
_Boundary:_ `packages/engine`
_Depends:_ T1, T3

`provider_credentials` cannot hold these: it is unique on `(provider_id, kind)`
(`packages/db/src/schema/provider-credentials.ts:28-31`) with no contact column, so it is
structurally one row per provider for the whole deployment. Per-contact custody lives on
`linked_accounts.tokens`.

- New `packages/engine/src/lib/linked-account-tokens.ts`:
  ```ts
  export interface LinkedAccountTokens {
    accessToken: string;
    refreshToken: string | null;
    /** ISO-8601 with offset. */
    expiresAt: string | null;
    scopes: string[];
  }

  export async function sealLinkedAccountTokens(opts: {
    db: Database; linkedAccountId: string; tokens: LinkedAccountTokens;
  }): Promise<void>;

  /** Returns null when absent, revoked, or undecryptable (logged, never thrown). */
  export async function readLinkedAccountTokens(opts: {
    db: Database; row: { id: string; tokens: string | null; tokensRevokedAt: Date | null };
    logger: Logger;
  }): Promise<LinkedAccountTokens | null>;

  /** Sets tokens = NULL, tokens_revoked_at = now(). Idempotent. */
  export async function markGrantRevoked(opts: {
    db: Database; linkedAccountId: string;
  }): Promise<void>;
  ```
- An undecryptable blob (rotated `BETTER_AUTH_SECRET`) resolves to `null` with a warn, NOT a throw:
  a cron must not die on one poisoned row.

Tests — `apps/api/src/__tests__/linked-account-tokens.test.ts` (vitest, real DB, `RUN`-namespaced
rows per `apps/api/src/__tests__/check-alerts-stranded.test.ts:1-15`):
- `"seals and reads back per-contact tokens"`
- `"never returns tokens for a revoked row"`
- `"a poisoned blob resolves to null and logs, rather than throwing"`
- `"markGrantRevoked is idempotent and leaves the link row live"` (asserts `unlinked_at IS NULL`,
  which is the whole point of DECISIONS §10)

### T5 — `refreshLinkedAccountToken`
_Boundary:_ `packages/engine`
_Depends:_ T2, T4

**Verdict: parallel implementation, not reuse and not generalization of `createTokenManager`.**
Defend it in the file's doc block, because "we already have a token manager" is the obvious
objection:

- `createTokenManager` (`packages/engine/src/lib/oauth-token-manager.ts:104`) is a **per-process
  singleton for ONE operator credential**. Its whole value is closure state: an in-memory `payload`
  cache (`:123`), an `absentCheckedAt` negative cache (`:124`), `warnedFailure`/`warnedInvalid`
  warn-once latches (`:126-127`), and a global `inflight` single-flight promise (`:129`). Every one
  of those is per-SUBJECT state. Instantiating one per contact means N closures held live in a cron
  that walks millions of rows, and a global single-flight that would serialize unrelated contacts.
- Its backoff is a flat 60s in a local variable (`FAILURE_BACKOFF_MS` at `:29`, `lastFailureAt` at
  `:126`). A cron restart erases it. Per-contact backoff must be **persisted** on the row, which is
  what `sync_failures` / `sync_next_at` in T1 are for. The persisted, jittered, exponential
  model to copy is `backoffMs(attempt)` at `packages/engine/src/workflows/deliver-webhook.ts:70`,
  whose `nextRetryAt` re-drive pattern is exactly this shape.
- It has **no terminal-failure state**: `invalid_grant` takes the identical path as a 500
  (`:216-236`), so a revoked grant retries forever. That is tolerable for one operator credential an
  admin will reconnect; it is not tolerable for a million player grants, and DECISIONS §10 requires
  a distinct terminal outcome.
- What IS reused: the constants and the wire semantics. Import `EXPIRY_SKEW_MS` from the token
  manager rather than re-typing 60s, and copy the rotation rule verbatim from `:180-186`.

- New `packages/engine/src/lib/linked-account-refresh.ts`:
  ```ts
  export type RefreshOutcome =
    | { status: "fresh"; accessToken: string }
    | { status: "refreshed"; accessToken: string }
    | { status: "revoked" }
    | { status: "transient"; detail: string }
    | { status: "no_tokens" };

  export async function refreshLinkedAccountToken(opts: {
    db: Database;
    logger: Logger;
    provider: AccountLinkProvider;
    row: LinkedAccountRow;
    fetchImpl?: typeof fetch;
    now?: () => number;
  }): Promise<RefreshOutcome>;
  ```
- Order: no stored tokens → `no_tokens`; unexpired beyond the skew → `fresh`; otherwise call
  `provider.refresh(tokens, fetchImpl)`, seal the result (keeping the old refresh token when the
  response omits one) → `refreshed`. Anything thrown → classify.
- **Classification reads the flag, it does not string-match.** PRD 01's `oauth2Link()` already
  throws `AccountLinkCallbackError` with a boolean `invalidGrant` field for exactly this branch
  (PRD 01 T3's `oauth2Link` refresh leg). So: `err instanceof AccountLinkCallbackError &&
  err.invalidGrant` → `markGrantRevoked` → `revoked`; everything else → `transient`. Do not add a
  second classifier that parses response bodies; a hand-authored provider that does not set the
  flag is treated as transient, which is the conservative direction.
- Conservative-by-default is the rule: a wrong `revoked` verdict silently kills a live player's
  property sync forever with no repair path short of a relink, so any ambiguity resolves to
  `transient`.

Tests — `apps/api/src/__tests__/linked-account-refresh.test.ts`, harness modelled on the
`makeHarness()` at `apps/api/src/__tests__/oauth-token-manager.test.ts:41-82` (fake `fetchImpl`,
fake `now`):
- `"returns fresh inside the skew window without calling the provider"`
- `"refreshes when inside the 60s skew"`
- `"keeps the stored refresh token when the response omits one"`
- `"invalid_grant sets tokens_revoked_at, nulls the blob, and leaves the link live"`
- `"a 500 is transient and leaves the tokens intact"`
- `"a network timeout is transient, not revoked"` (the conservative-classification mutation test)
- `"a thrown error without the invalidGrant flag classifies as transient"`

### T6 — Best-effort `revoke()` on unlink
_Boundary:_ `packages/engine`
_Depends:_ T2, T4

- In the link store's unlink path (PRD 03's `unlinkAccount`), after the row transitions and BEFORE
  the outbound `account.unlinked` emit, read the tokens, call `provider.revoke?.(tokens, fetchImpl)`
  (PRD 01's top-level wire, emitted only when `revokeEndpoint` and `storeTokens` are both set) inside a
  try/catch with an `AbortSignal.timeout`, warn on failure, and clear the blob either way.
- Never let a revoke failure fail the unlink. The player asked to unlink; a provider being down is
  not their problem.

Tests — `apps/api/src/__tests__/account-links-unlink-revoke.test.ts`:
- `"calls the provider revoke wire on unlink"`
- `"clears the sealed blob even when revoke throws"`
- `"an unavailable provider does not fail the unlink"`

### T7 — The `refresh-linked-accounts` cron
_Boundary:_ `packages/engine`
_Depends:_ T5

Template is `packages/engine/src/workflows/crm-reconcile.ts:112-129`, not `check-alerts.ts`
(`check-alerts` carries no `onCrons` at all and does one unbounded query, so it is the wrong model
on both counts).

- New `packages/engine/src/workflows/refresh-linked-accounts.ts`:
  ```ts
  /** The sweep body, exported as the test seam (the runCrmReconcile idiom). */
  export async function runLinkedAccountSync(deps: {
    db: Database;
    logger: Logger;
    providers: AccountLinkProviderRegistry;
    fetchImpl?: typeof fetch;
    now?: () => number;
  }): Promise<{
    scanned: number; synced: number; revoked: number;
    transient: number; skippedProviders: string[];
  }>;

  export const refreshLinkedAccountsTask = hatchet.task({
    name: "refresh-linked-accounts",
    onCrons: [process.env.ACCOUNT_LINK_SYNC_CRON ?? "17 * * * *"],
    retries: 1,
    executionTimeout: "600s",
    concurrency: {
      expression: "'refresh-linked-accounts'",
      maxRuns: 1,
      limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
    },
    fn: async () => { /* self-bootstrap db + logger from process.env */ },
  });
  ```
  The default `"17 * * * *"` is hourly off the hour deliberately: `*/5` and `*/1` crons already exist
  (`bucket-reconcile.ts:85`, `deliver-webhook.ts:430`, `send-campaign.ts:714`) and a top-of-hour
  default would pile every sweep onto the same tick.
- **Batching**, per provider, concretely:
  - Keyset cursor over `linked_accounts.id` ascending, `BATCH_SIZE = 200` (smaller than the repo's
    usual 500 because each row costs a network call, not a row-write). Seed the cursor with the
    all-zero uuid, as `apps/api/src/workflows/gtm-score.ts:342-343` does.
  - Predicate: `provider = :p AND unlinked_at IS NULL AND tokens_revoked_at IS NULL
    AND (sync_next_at IS NULL OR sync_next_at <= now())
    AND (synced_at IS NULL OR synced_at < now() - :every)`.
    `:every` is the provider's `sync.every` rendered as a Postgres interval, computed once per
    provider as `durationToMs(provider.sync.every)` and bound as
    `make_interval(secs => :everyMs / 1000.0)` (or the equivalent `:everyMs || ' milliseconds'`
    cast). This is the entire reason `every` is a `Duration` and not a cron string (DECISIONS §10):
    the staleness test is a per-row SQL comparison, so there is nothing to parse and no per-provider
    "last tick" state to keep.
  - `MAX_BATCHES_PER_PROVIDER_PER_TICK = 50` (10k rows/provider/tick). When the cap is hit, `log()`
    the fact and the remaining cursor. **A silent truncation reads as "we covered everything" when
    we did not**, the cap must appear in the log line and in the returned counts.
  - Reuse `runBatchedBackfill` from `packages/engine/src/lib/backfill.ts:43` if its
    `runBatch(db, batchSize) => rowsProcessed` shape fits; if the per-provider cursor makes that
    awkward, hand-roll the same loop and say why in a comment rather than bending the helper.
- **Pacing**: within a batch, run at most `rateLimit.concurrency` (default 4) provider calls at once
  and space call starts by at least `rateLimit.minIntervalMs` (default 250ms). There is no
  `p-limit` in this repo and none should be added; a ~20-line in-file `paced(items, opts, fn)`
  helper is enough, and it belongs next to the cron so its bounds are visible where they matter.
  Sleep between batches with the `sleep` idiom at
  `packages/engine/src/workflows/backfill-contact-id.ts:126`.
- **Per-row flow**: `refreshLinkedAccountToken` → on `revoked`, count it and skip (the row is now
  permanently excluded by the predicate); on `transient`, `sync_failures += 1` and
  `sync_next_at = now() + backoffMs(sync_failures)` using the jittered exponential from
  `deliver-webhook.ts:70`; on `fresh`/`refreshed`/`no_tokens`, call `provider.sync.read()`,
  then write the facts and set `synced_at = now()`, `sync_failures = 0`, `sync_next_at = NULL`.
- **The property write goes through `ingestEvent`**, not a direct UPDATE:
  ```ts
  await ingestEvent({
    event: "account.synced",
    userId: contactKeyForRow,
    properties: { provider },          // scalars only
    contactProperties: facts,          // flat namespaced scalars
    allowCreate: false,
  });
  ```
  `ingestEvent` is the only write path that re-runs `checkBucketMembership`
  (`apps/api/src/workflows/gtm-score.ts:386-390`), so a direct UPDATE would leave a bucket keyed on
  `steam_playtime_2wk` permanently stale. `allowCreate: false` because the contact provably already
  exists (a link row cannot exist without one), so the cron must never mint.
  `account.synced` is an **ingest-only** event name: it is NOT added to `WEBHOOK_EVENT_TYPES` and
  is NOT one of the three locked outbound events (DECISIONS §8). See the `account.synced` bullet under
  **Locked decisions specific to this PRD**.
- A provider with no `sync` block is skipped and named in `skippedProviders`.
- The whole per-provider loop is try/caught so one broken provider cannot abort the sweep, matching
  `check-alerts.ts:138-142`.
- **Registration** (the worker process only, three edits, per `apps/api/src/worker.ts:59-60`
  "registering the task in the worker is what schedules it"):
  1. `packages/engine/src/worker.ts`, import beside `crmReconcileTask` (`:32`) and add to
     `baseWorkflows` beside it (`:145`). The `builtinTasks` count at `:196-199` is derived, so it
     self-updates.
  2. `packages/engine/src/index.ts`, re-export `refreshLinkedAccountsTask` and
     `runLinkedAccountSync` next to the `checkAlertsTask` export block (`:967-970`).
  3. `packages/engine/src/env.ts`, declare
     `ACCOUNT_LINK_SYNC_CRON: z.string().default("17 * * * *")` beside `BUCKET_RECONCILE_CRON`
     (`:327-341`). Declaration only: `onCrons` reads raw `process.env` at module load because the
     task literal is evaluated at import time, which is exactly what the comment at
     `packages/engine/src/env.ts:329-331` says.

Tests — `apps/api/src/__tests__/account-link-sync-cron.test.ts`, driving
`runLinkedAccountSync` directly with a real DB and a fake provider registry (crons are never
tested through Hatchet in this repo):
- `"writes flat namespaced scalars onto contacts.properties"`
- `"writes through ingestEvent so a bucket keyed on the property re-evaluates"` (the load-bearing
  one: assert the bucket flips, not just that the column changed)
- `"omits an absent fact rather than writing null"`
- `"skips a row synced more recently than the provider's sync.every"`
- `"skips a revoked row"`
- `"an invalid_grant during the sweep revokes and does not unlink"`
- `"a transient failure sets a backoff and retries on a later tick"`
- `"pages with a keyset cursor and never loads more than BATCH_SIZE rows at once"`
- `"caps batches per provider per tick and logs the truncation"`
- `"one throwing provider does not abort the other provider's sweep"`
- `"never exceeds the declared concurrency for a provider"`

Check whether this file must be added to `WEBHOOK_FANOUT` in `apps/api/vitest.config.ts:14-38`: it
scans a whole table and ingests events, which is the same class of global side effect the two
non-webhook entries there were added for.

### T8 — Prove the token-free path end to end with Steam
_Boundary:_ `packages/engine`
_Depends:_ T7, PRD 01, PRD 06

**The Steam sync reader itself is PRD 01 T4's** (`steamOpenIdLink()` emits `sync` only
when a `webApiKey` is supplied, `prds/01-provider-contract.md` T4), and the
configuration is PRD 06 T3's. This task does not re-author either. It adds
the one thing neither can: proof that the cron drives a token-free provider correctly, since Steam
is the only provider that exercises that branch and a bug there is invisible everywhere else.

- Add `rateLimit: { concurrency: 2, minIntervalMs: 500 }` to the Steam `sync` block. Steam's
  documented budget is 100k calls/day per key, orders of magnitude tighter than Twitch's Helix
  bucket, so the default 4/250ms is wrong for it.
- Confirm (do not re-add) that `STEAM_WEB_API_KEY` is declared
  `z.string().min(1).optional()` wherever PRD 06 put it, and that an absent key means Steam simply
  declares no `sync` rather than throwing at boot.
- The cron must report a provider that declares no `sync` in `skippedProviders`, so an operator
  who forgot the key sees it in one log line rather than wondering why nothing updates.

Tests — `apps/api/src/__tests__/account-link-sync-steam.test.ts`, driving
`runLinkedAccountSync` against PRD 01's deterministic Steam fake:
- `"syncs a Steam link that has no stored tokens"`, the token-free proof. Assert
  `tokens IS NULL` before AND after, so a future change that starts sealing something fails here.
- `"never calls the refresh path for a provider with no refresh wire"`
- `"reports Steam in skippedProviders when no web api key is configured"`
- `"a Steam API 429 is transient and backs off"`
- `"honours the tighter Steam rate limit rather than the default"`

## Seams

**Real provider credentials**, shared with PRD 07 and PRD 16. Build to deterministic Fakes for every
provider so the entire path is green with no secrets, mark the PRD `[~]`, and keep going.

The exact human ask for THIS PRD:
- **`STEAM_WEB_API_KEY`**, a Steam Web API key from `https://steamcommunity.com/dev/apikey`. This is
  the only credential T8 needs; the Steam sync read is a public read and needs no player token. It is
  a genuine requirement HERE (no key ⇒ no `sync` capability ⇒ nothing for the cron to do) even though
  it is optional for linking itself — see PRD 06's provider matrix.
- **Twitch** sync reads need the OAuth app client id + secret already enumerated by PRD 06/07/16;
  this PRD adds no new ask beyond what those already request. Discord is out of v1 (DECISIONS §12)
  and needs nothing here.

Nothing here is blocked on the seam: every task's tests run against the Fakes.

## Done when

- [ ] `linked_accounts` carries `tokens`, `tokens_revoked_at`, `synced_at`, `sync_failures`,
      `sync_next_at` and the partial due-index, with a committed generated migration.
- [ ] `sealJson`/`unsealJson` live in one module and `provider-credentials.ts` imports them; the
      pre-extraction fixture still decrypts.
- [ ] `refreshLinkedAccountsTask` is in `baseWorkflows` in `packages/engine/src/worker.ts` and
      exported from `packages/engine/src/index.ts`; `ACCOUNT_LINK_SYNC_CRON` is declared in
      `env.ts`.
- [ ] A grep for `sendEmail`-style direct `db.update(contacts).set({ properties`` in the new cron
      returns nothing: the write goes through `ingestEvent`.
- [ ] `invalid_grant` handling has a test asserting the link row is still LIVE afterwards. Deleting
      the "do not unlink" behaviour must fail a test.
- [ ] The batch cap logs what it dropped; a test asserts the log line.
- [ ] No new entry in `WEBHOOK_EVENT_TYPES` and no new entry in either vendored catalog copy.
- [ ] Every new name this PRD introduces reads `sync`, never `enrichment`:
      `grep -rn "enrich" packages/engine/src/workflows/refresh-linked-accounts.ts
      packages/db/src/schema/linked-accounts.ts packages/engine/src/lib/linked-account-*.ts`
      returns nothing.
- [ ] The pre-existing enrichment subsystem is byte-identical: `git diff --stat` shows no change to
      `lib/enrichment-provider-registry.ts`, `lib/enrichment-ledger.ts`, `lib/refine.ts`, the
      `ENRICHMENT_*` env declarations, or the `createHogsendClient({ enrichment })` option.
- [ ] The due predicate compares `synced_at` against `durationToMs(provider.sync.every)` rendered as
      an interval, and no cron-expression parser was added to the repo.
- [ ] Changesets added for `@hogsend/core`, `@hogsend/db` and `@hogsend/engine`.
- [ ] Gates green from the worktree root:
      ```
      pnpm lint
      pnpm check-types
      cd apps/api && pnpm test
      ```
- [ ] Plus, since this changes the engine's public surface: `pnpm build`.
- [ ] `pnpm --filter @hogsend/engine test` and `pnpm --filter @hogsend/core test` green (both are
      `node:test` via `tsx --test`, not vitest).
- [ ] One conventional commit per task, local only. No push, no PR (DECISIONS §13).

## Implementation Notes
