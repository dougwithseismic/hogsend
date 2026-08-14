import type {
  AccountLinkHooks,
  AfterLinkContext,
  AfterUnlinkContext,
  LinkedIdentity,
  LinkTokens,
} from "@hogsend/core";
import { ACCOUNT_LINK_HOOK_TIMEOUT_MS } from "@hogsend/core";
import { contacts, type Database, linkedAccounts } from "@hogsend/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getAppSecret } from "./app-secret.js";
import type { Logger } from "./logger.js";
import { sealJson, unsealJson } from "./provider-credentials.js";

/**
 * The account-link store: the ONE place a `linked_accounts` row is ever
 * written (PRD 03). It computes the monotonic per-pair version under a
 * Postgres advisory lock, enforces the live-owner rule (DECISIONS §6.1/§6.2),
 * performs a relink as a two-version soft-unlink-then-insert (DECISIONS §5),
 * enforces `multiple: false` through the `singleton` column, seals tokens with
 * the engine's AES-256-GCM construction, and invokes `afterLink`/`afterUnlink`
 * post-commit.
 *
 * House style follows {@link file://./groups.ts}: single-object-in /
 * result-object-out, `db` injected, typed error classes.
 *
 * THIS MODULE IS THE SOLE INVOKER of `afterLink` and `afterUnlink`
 * (DECISIONS §15.4). Routes, hosted pages and SDK paths pass
 * `hooks: container.accountLinkHooks` in and call nothing themselves — the
 * original stack specified the invocation in both places, which would have
 * fired every customer hook twice per link, forever, and the at-least-once
 * documentation would have hidden it.
 *
 * `beforeLink` is NEVER invoked here. It is the pre-write veto and PRD 07's
 * callback owns it (DECISIONS §9): moving it into the store would run it after
 * the transaction opened, holding the pair advisory lock across a customer's
 * network call. The store ACCEPTS an already-vetoed decision via
 * `LinkAccountInput.vetoed` and must never re-run the hook.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown after {@link MAX_VERSION_RACE_RETRIES} attempts all failed on a
 * retryable condition (the version-index 23505, a 40P01/40001, or a stale lock
 * set). Never carries token material. The caller sees this instead of a
 * silently duplicated version — a duplicate version is a permanent, invisible
 * wrong answer in the consumer's `incoming.version > stored.version` guard.
 */
export class AccountLinkVersionRaceError extends Error {
  constructor(
    public readonly provider: string,
    public readonly providerUserId: string,
  ) {
    super(
      `account link mutation for (${provider}, ${providerUserId}) still ` +
        `conflicting after ${MAX_VERSION_RACE_RETRIES} attempts`,
    );
    this.name = "AccountLinkVersionRaceError";
  }
}

/**
 * INTERNAL control-flow error, treated as retryable by the mutation retry
 * (T5): the singleton pre-read's pair set went stale between the pre-read and
 * the lock, so the transaction found a singleton row whose pair lock it does
 * NOT hold. The correct response is to abort and re-run the whole mutation
 * from the pre-read — grabbing a lock mid-transaction is the staged
 * acquisition that deadlocks two mirror-image swaps (each already holds what
 * the other wants; Postgres kills one with 40P01).
 */
export class AccountLinkLockSetChangedError extends Error {
  constructor(provider: string, providerUserId: string) {
    super(
      `account link singleton pre-read went stale for (${provider}, ` +
        `${providerUserId}) — retrying from the pre-read`,
    );
    this.name = "AccountLinkLockSetChangedError";
  }
}

// ---------------------------------------------------------------------------
// Types (PRD 03 T1)
// ---------------------------------------------------------------------------

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type LinkMutationStatus =
  | "linked"
  | "relinked"
  | "unchanged"
  | "rejected";

export interface LinkedAccountRecord {
  id: string;
  contactId: string;
  provider: string;
  providerUserId: string;
  username: string | null;
  verifiedEmail: string | null;
  avatarUrl: string | null;
  method: "oauth" | "import";
  singleton: boolean;
  /** bigint. STRING at every boundary — never a JS number (DECISIONS §5.1). */
  version: string;
  linkedAt: Date;
  unlinkedAt: Date | null;
  unlinkReason: string | null;
  tokensRevokedAt: Date | null;
  /** Always redacted to a boolean. The blob NEVER leaves this module. */
  hasTokens: boolean;
}

/**
 * The contact facts every downstream plane needs, read by a join to `contacts`
 * INSIDE the mutation's transaction (DECISIONS §15.5). PRD 08's payloads carry
 * `userId` and `email`; PRD 01's hook contexts carry the same two. Neither
 * lives on `linked_accounts`, and neither may be looked up at emit time — a
 * second read after the lock released is no longer the state that was
 * committed.
 */
export interface LinkOwner {
  contactId: string;
  /**
   * `contactKey()` = `external_id ?? anonymous_id ?? id`, contacts.ts:863-865.
   * ONE definition across PULL, PUSH and IN-PROCESS, so a consumer can join on
   * it. NOT raw `externalId`.
   */
  userId: string | null;
  /** The CONTACT's email. Never `linked_accounts.verified_email`. */
  email: string | null;
}

export interface LinkAccountInput {
  db: Database;
  provider: string;
  identity: LinkedIdentity;
  /**
   * ALREADY RESOLVED by the caller. The store never resolves, never mints, and
   * never accepts an `anonymousId`: the cold-path resolve is PRD 07's
   * (DECISIONS §6.10) and `resolveOrCreateContact` takes its own contact-key
   * advisory locks, which cannot be nested inside the pair lock.
   */
  contactId: string;
  method: "oauth" | "import";
  /** From the provider definition; the CALLER resolves the default (`true`). */
  multiple: boolean;
  /** Only consulted when `multiple === false`. */
  onConflict: "replace" | "reject";
  /** From `capabilities.tokens`. False ⇒ tokens are dropped, not stored. */
  storeTokens: boolean;
  /**
   * TRUE only from a completed hosted callback (DECISIONS §6.1). The import
   * path (§6.2) passes FALSE and is therefore structurally insert-only: it
   * cannot graft a link off its current owner no matter what it sends.
   */
  allowDisplaceLiveOwner: boolean;
  /**
   * PRD 07 already ran `beforeLink` and it REFUSED. The store must not re-run
   * the hook; it just records the refusal.
   */
  vetoed?: boolean;
  /**
   * Override the INSERTed row's `linked_at`. The import path (PRD 09 T5) uses
   * it to preserve the customer's historical timestamp; every other caller
   * omits it and takes the column default (`now()`).
   *
   * It touches ONLY the insert. A same-owner refresh must not rewrite the
   * timestamp of a link that already exists, and no unlink path reads it.
   */
  linkedAt?: Date;
  hooks?: AccountLinkHooks;
  logger?: Logger;
}

/**
 * A soft-unlinked row this mutation displaced, with the facts PRD 08 needs to
 * emit its `account.unlinked` without re-reading the database.
 */
export interface DisplacedLink {
  contactId: string;
  provider: string;
  providerUserId: string;
  /** That pair's OWN next version (string, DECISIONS §5.1). */
  version: string;
  owner: LinkOwner;
}

export type LinkAccountResult =
  | {
      status: "linked";
      row: LinkedAccountRecord;
      relink: false;
      version: string;
      owner: LinkOwner;
      /**
       * Present when a `multiple: false` / `onConflict: "replace"` mutation
       * soft-unlinked the contact's OTHER pair to make room. That row's facts
       * are carried here (its pair, its own next version, its owner) because
       * the store returns the full facts each mutation produced (DECISIONS §8)
       * and the write is otherwise invisible to the caller.
       */
      replacedSingleton?: DisplacedLink;
    }
  | {
      status: "relinked";
      row: LinkedAccountRecord;
      relink: true;
      version: string;
      owner: LinkOwner;
      previous: { contactId: string; version: string; owner: LinkOwner };
      replacedSingleton?: DisplacedLink;
    }
  | {
      status: "unchanged";
      row: LinkedAccountRecord;
      version: string;
      owner: LinkOwner;
    }
  | {
      status: "rejected";
      reason: "live_owner_conflict" | "singleton_conflict" | "vetoed";
      currentOwnerContactId?: string;
    };

export interface UnlinkAccountInput {
  db: Database;
  provider: string;
  providerUserId: string;
  reason: "player" | "api" | "relinked";
  /**
   * Guard: only unlink when this contact is the live owner. Omit for admin.
   *
   * REQUIRED on both player-facing revokes (PRD 09's `/accounts/me/revoke` and
   * PRD 11's manage page). It is evaluated INSIDE the pair lock, after the
   * live-owner probe, which is the whole point: a caller that reads the row,
   * compares in application code, then unlinks by pair has a window in which a
   * hosted callback relinks the pair, and contact A's revoke then destroys
   * contact B's just-proven link. This is the same read-then-write hazard
   * PRD 09 forbids for the import path.
   */
  expectContactId?: string;
  /** Best-effort provider-side token revoke, run post-commit. */
  revoke?: (tokens: LinkTokens) => Promise<void>;
  hooks?: AccountLinkHooks;
  logger?: Logger;
}

export type UnlinkAccountResult =
  | {
      status: "unlinked";
      row: LinkedAccountRecord;
      version: string;
      owner: LinkOwner;
    }
  | { status: "not_found" }
  | { status: "rejected"; reason: "not_owner"; currentOwnerContactId: string };

/**
 * `unlinkAccountInTx`'s result. A union rather than the bare
 * `{ version, owner }`: the acceptance criteria require the `expectContactId`
 * guard to REJECT (mutating nothing) on both entry points, and the merge
 * caller must be able to see "the row you meant is already gone" without a
 * throw unwinding its whole transaction.
 */
export type UnlinkAccountInTxResult =
  | { status: "unlinked"; version: string; owner: LinkOwner }
  | { status: "not_found" }
  | { status: "rejected"; reason: "not_owner"; currentOwnerContactId: string };

// ---------------------------------------------------------------------------
// The advisory lock (PRD 03 T2)
// ---------------------------------------------------------------------------

/**
 * Serialize every mutation for ONE platform account. `hashtext` folds the
 * string into the int4 the single-arg `pg_advisory_xact_lock` overload takes;
 * the lock is TRANSACTION-scoped, so it releases on COMMIT or ROLLBACK with no
 * unlock call and no leak on a thrown error. Same idiom as
 * `lib/blueprint-lock.ts:20` and `lib/contacts.ts:1223`.
 *
 * The key is `al:<provider>:<providerUserId>`. The `al:` prefix keeps it from
 * colliding with the `bp-graph:` and `<kind>:<value>` namespaces already in
 * use; `hashtext` collisions across namespaces are possible in principle and
 * cost only a spurious wait, never a correctness bug.
 */
export function pairLockKey(provider: string, providerUserId: string): string {
  return `al:${provider}:${providerUserId}`;
}

/**
 * Exported for the lock-order unit test only; production callers are the
 * mutations in this module.
 */
export async function lockPairs(tx: Tx, keys: string[]): Promise<void> {
  // SORTED, deduped: when a `multiple:false` replace has to touch TWO pairs,
  // two mirror-image concurrent replaces taking them in opposite orders is a
  // textbook deadlock. A total order removes the cycle.
  for (const key of [...new Set(keys)].sort()) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * `COALESCE(MAX(version), 0) + 1` across ALL rows for the pair, live and
 * unlinked (DECISIONS §5.1). Computed INSIDE the pair lock, in SQL — the
 * increment never happens in JS, and the value crosses out of Postgres as a
 * string which `BigInt()` carries losslessly into the drizzle
 * `mode: "bigint"` column. Never `Number()`, never `parseInt`.
 */
async function nextVersion(
  tx: Tx,
  provider: string,
  providerUserId: string,
): Promise<bigint> {
  const rows = (await tx.execute(sql`
    SELECT COALESCE(MAX(version), 0) + 1 AS next
    FROM linked_accounts
    WHERE provider = ${provider} AND provider_user_id = ${providerUserId}
  `)) as unknown as Array<{ next: string | bigint }>;
  const next = rows[0]?.next;
  if (next === undefined) {
    throw new Error("nextVersion: aggregate returned no row");
  }
  return BigInt(next);
}

/**
 * The owner read, INSIDE the locked transaction (DECISIONS §15.5). `userId`
 * is `contactKey()` (`external_id ?? anonymous_id ?? id`,
 * `lib/contacts.ts:863-865`), NEVER raw `externalId`; `email` is the
 * CONTACT's own address, never the provider-reported `verifiedEmail`
 * (DECISIONS §6.3/§6.4 — wiring the provider email in here is the grafting
 * vector).
 */
async function readOwner(tx: Tx, contactId: string): Promise<LinkOwner> {
  const [c] = await tx
    .select({
      id: contacts.id,
      externalId: contacts.externalId,
      anonymousId: contacts.anonymousId,
      email: contacts.email,
    })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);
  if (!c) return { contactId, userId: null, email: null };
  return {
    contactId,
    userId: c.externalId ?? c.anonymousId ?? c.id,
    email: c.email ?? null,
  };
}

type LinkedAccountRow = typeof linkedAccounts.$inferSelect;

/**
 * The ONE projection from a row to the public shape. This is where `tokens`
 * collapses to `hasTokens` — the sealed blob never leaves this module, and
 * nothing else in the engine may select `linkedAccounts.tokens` except the
 * property-sync path (PRD 14).
 */
function toLinkedAccountRecord(row: LinkedAccountRow): LinkedAccountRecord {
  return {
    id: row.id,
    contactId: row.contactId,
    provider: row.provider,
    providerUserId: row.providerUserId,
    username: row.username,
    verifiedEmail: row.verifiedEmail,
    avatarUrl: row.avatarUrl,
    method: row.method,
    singleton: row.singleton,
    // Drizzle's `mode: "bigint"` yields a JS BigInt — String() is lossless.
    // NEVER Number()/parseInt: bigint exceeds Number.MAX_SAFE_INTEGER and a
    // rounded version breaks the consumer's monotonic guard invisibly.
    version: String(row.version),
    linkedAt: row.linkedAt,
    unlinkedAt: row.unlinkedAt,
    unlinkReason: row.unlinkReason,
    tokensRevokedAt: row.tokensRevokedAt,
    hasTokens: row.tokens !== null,
  };
}

/** Seal a token grant. AES-256-GCM via `lib/provider-credentials.ts` — ONE
 * construction in the engine, one place a secret rotation is handled.
 *
 * Async only because the secret is fetched lazily (see `lib/app-secret.ts`);
 * the crypto itself is synchronous, and both call sites are already inside the
 * link transaction's async body. */
async function sealTokens(tokens: LinkTokens): Promise<string> {
  return sealJson(tokens, await getAppSecret());
}

// ---------------------------------------------------------------------------
// Retry (PRD 03 T5)
// ---------------------------------------------------------------------------

export const MAX_VERSION_RACE_RETRIES = 3;

/**
 * Walk `err.cause` for the postgres error. Drizzle wraps the driver error, so
 * `code`/`constraint_name` live on the CAUSE, not the top-level error —
 * string-matching the message is not acceptable. Depth-bounded against
 * pathological cause cycles.
 */
function findPgError(
  err: unknown,
): { code: string; constraint?: string } | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 10 && cur; depth++) {
    if (typeof cur === "object" && cur !== null) {
      const c = cur as {
        code?: unknown;
        constraint_name?: unknown;
        constraint?: unknown;
        cause?: unknown;
      };
      if (typeof c.code === "string") {
        const constraint =
          typeof c.constraint_name === "string"
            ? c.constraint_name
            : typeof c.constraint === "string"
              ? c.constraint
              : undefined;
        return { code: c.code, constraint };
      }
      cur = c.cause;
    } else {
      break;
    }
  }
  return null;
}

/**
 * The RETRYABLE set is exactly three things (PRD 03 T5):
 *
 * 1. 23505 on `linked_accounts_provider_uid_version_idx` — the lost-race
 *    backstop fired; another transaction burned the version we read.
 * 2. 40P01 (deadlock detected) / 40001 (serialization failure) — Postgres
 *    already rolled the transaction back and chose us as the victim.
 *    Transient by definition; surfacing one is a 500 on a player's callback
 *    for no reason.
 * 3. `AccountLinkLockSetChangedError` — the pre-read's pair set went stale;
 *    re-running from the pre-read locks the right set.
 *
 * Any OTHER 23505 (the live index, the singleton index) is NOT retryable: it
 * means a policy branch was wrong or a concurrent mutation legitimately won,
 * and retrying would loop.
 */
function isRetryable(err: unknown): boolean {
  if (err instanceof AccountLinkLockSetChangedError) return true;
  const pg = findPgError(err);
  if (!pg) return false;
  if (pg.code === "40P01" || pg.code === "40001") return true;
  return (
    pg.code === "23505" &&
    pg.constraint === "linked_accounts_provider_uid_version_idx"
  );
}

async function withVersionRaceRetry<T>(
  opts: { provider: string; providerUserId: string; logger?: Logger },
  run: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_VERSION_RACE_RETRIES; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (!isRetryable(err)) throw err;
      opts.logger?.warn("accountLink mutation retrying", {
        provider: opts.provider,
        providerUserId: opts.providerUserId,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
      if (attempt === MAX_VERSION_RACE_RETRIES) {
        // Never write a duplicate version, never fall back to a version
        // computed outside the lock.
        throw new AccountLinkVersionRaceError(
          opts.provider,
          opts.providerUserId,
        );
      }
    }
  }
  // Unreachable: the loop either returns or throws.
  throw new AccountLinkVersionRaceError(opts.provider, opts.providerUserId);
}

// ---------------------------------------------------------------------------
// Post-commit hooks (PRD 03 T6)
// ---------------------------------------------------------------------------

/**
 * Invoke one after-hook post-commit: bounded by
 * {@link ACCOUNT_LINK_HOOK_TIMEOUT_MS}, FAIL-OPEN. A throw or a timeout is
 * logged and never changes the returned result — the write already committed,
 * and reporting failure would make the caller retry a completed mutation.
 * Posture precedent: cold-connect's `afterBind`
 * (`cold-connect/index.ts:222-233`).
 */
async function invokeAfterHook(
  name: "afterLink" | "afterUnlink",
  fn: (() => Promise<void> | void) | undefined,
  logger: Logger | undefined,
  meta: { provider: string; providerUserId: string },
): Promise<void> {
  if (!fn) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve(fn()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`${name} exceeded ${ACCOUNT_LINK_HOOK_TIMEOUT_MS}ms`),
            ),
          ACCOUNT_LINK_HOOK_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    logger?.warn(`accountLink ${name} threw`, {
      provider: meta.provider,
      providerUserId: meta.providerUserId,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// linkAccount (PRD 03 T3 + T4)
// ---------------------------------------------------------------------------

/** What the transaction hands back for post-commit hook invocation. */
type LinkTxOutcome =
  | { kind: "unchanged"; row: LinkedAccountRow; owner: LinkOwner }
  | {
      kind: "rejected";
      reason: "live_owner_conflict" | "singleton_conflict";
      currentOwnerContactId?: string;
    }
  | {
      kind: "written";
      row: LinkedAccountRow;
      owner: LinkOwner;
      previous: { contactId: string; version: string; owner: LinkOwner } | null;
      replacedSingleton: DisplacedLink | null;
    };

export async function linkAccount(
  input: LinkAccountInput,
): Promise<LinkAccountResult> {
  // PRD 07 ran `beforeLink` and it REFUSED — record the refusal, run nothing.
  // The store never re-runs the veto (DECISIONS §9).
  if (input.vetoed) return { status: "rejected", reason: "vetoed" };

  const { db, provider, identity } = input;
  const providerUserId = identity.providerUserId;
  const targetKey = pairLockKey(provider, providerUserId);

  const outcome = await withVersionRaceRetry(
    { provider, providerUserId, logger: input.logger },
    async (): Promise<LinkTxOutcome> => {
      // Step 0, OUTSIDE the transaction: the singleton pre-read. It exists so
      // the FULL SET of pairs the transaction will touch is known before it
      // takes its first lock. It is a HINT, not a decision: the row may change
      // between the pre-read and the lock, so T4 re-verifies it inside the
      // lock. Skipped entirely for `multiple: true` (never a second pair).
      let preReadKeys: string[] = [];
      if (!input.multiple) {
        const [pre] = await db
          .select({
            provider: linkedAccounts.provider,
            providerUserId: linkedAccounts.providerUserId,
          })
          .from(linkedAccounts)
          .where(
            and(
              eq(linkedAccounts.contactId, input.contactId),
              eq(linkedAccounts.provider, provider),
              isNull(linkedAccounts.unlinkedAt),
              eq(linkedAccounts.singleton, true),
            ),
          )
          .limit(1);
        if (pre) preReadKeys = [pairLockKey(pre.provider, pre.providerUserId)];
      }

      return db.transaction(async (tx) => {
        // (1) EVERY pair lock this transaction might need, sorted + deduped,
        // as the FIRST statement. Acquiring a second lock later, once the
        // probe has revealed which pair to displace, is a textbook deadlock:
        // two mirror-image swaps each already hold the other's second target.
        const lockedKeys = [targetKey, ...preReadKeys];
        await lockPairs(tx, lockedKeys);
        const lockedSet = new Set(lockedKeys);

        // (2) The live-owner probe.
        const [live] = await tx
          .select()
          .from(linkedAccounts)
          .where(
            and(
              eq(linkedAccounts.provider, provider),
              eq(linkedAccounts.providerUserId, providerUserId),
              isNull(linkedAccounts.unlinkedAt),
            ),
          )
          .limit(1);

        // Same-owner refresh: display fields (and tokens when supplied), NO
        // version bump, NO emission. A display refresh is not a state
        // transition and must not consume a version the consumer would then
        // see as a gap (there is deliberately no `account.updated` event).
        if (live && live.contactId === input.contactId) {
          const set: Partial<typeof linkedAccounts.$inferInsert> = {
            username: identity.username ?? null,
            verifiedEmail: identity.verifiedEmail ?? null,
            avatarUrl: identity.avatarUrl ?? null,
            updatedAt: new Date(),
          };
          if (input.storeTokens && identity.tokens) {
            set.tokens = await sealTokens(identity.tokens);
          }
          const [updated] = await tx
            .update(linkedAccounts)
            .set(set)
            .where(eq(linkedAccounts.id, live.id))
            .returning();
          if (!updated) throw new Error("refresh update returned no row");
          const owner = await readOwner(tx, input.contactId);
          return { kind: "unchanged", row: updated, owner };
        }

        // Different-owner + no displacement right: only a completed hosted
        // callback may MOVE a link (DECISIONS §6.1); the import path is
        // structurally insert-only (§6.2).
        if (live && !input.allowDisplaceLiveOwner) {
          return {
            kind: "rejected",
            reason: "live_owner_conflict",
            currentOwnerContactId: live.contactId,
          };
        }

        // (T4) `multiple: false`: RE-VERIFY the pre-read under the lock. The
        // `singleton` COLUMN is the enforcement, not this code path: the
        // partial unique index `linked_accounts_contact_provider_singleton_idx`
        // is what makes a bug here a 23505 instead of a silent second link.
        let replacedSingleton: DisplacedLink | null = null;
        if (!input.multiple) {
          const [own] = await tx
            .select()
            .from(linkedAccounts)
            .where(
              and(
                eq(linkedAccounts.contactId, input.contactId),
                eq(linkedAccounts.provider, provider),
                isNull(linkedAccounts.unlinkedAt),
                eq(linkedAccounts.singleton, true),
              ),
            )
            .limit(1);
          if (own) {
            if (input.onConflict === "reject") {
              return { kind: "rejected", reason: "singleton_conflict" };
            }
            const ownKey = pairLockKey(own.provider, own.providerUserId);
            if (!lockedSet.has(ownKey)) {
              // The pre-read missed this pair (it changed under us). Its lock
              // is NOT held — do NOT acquire one here; abort and let the
              // bounded retry re-run from the pre-read.
              throw new AccountLinkLockSetChangedError(
                provider,
                providerUserId,
              );
            }
            // That row is a DIFFERENT pair with its OWN version sequence, and
            // its lock is already held (the pre-read put it in the first
            // statement's sorted set).
            const ownNext = await nextVersion(
              tx,
              own.provider,
              own.providerUserId,
            );
            const now = new Date();
            await tx
              .update(linkedAccounts)
              .set({
                unlinkedAt: now,
                unlinkReason: "relinked",
                version: ownNext,
                updatedAt: now,
              })
              .where(eq(linkedAccounts.id, own.id));
            replacedSingleton = {
              contactId: own.contactId,
              provider: own.provider,
              providerUserId: own.providerUserId,
              version: String(ownNext),
              owner: await readOwner(tx, own.contactId),
            };
          }
        }

        // Relink: TWO statements, TWO versions. The displaced row's bump to
        // N+1 (below the new row's N+2) is what makes the consumer's
        // `incoming.version > stored.version` guard discard a LATE
        // `account.unlinked`: N+1 is not greater than N+2. Emitting the
        // unlink at the old row's ORIGINAL version would let the late unlink
        // win and permanently record the wrong owner. Load-bearing ordering.
        let previous: {
          contactId: string;
          version: string;
          owner: LinkOwner;
        } | null = null;
        if (live) {
          const displacedVersion = await nextVersion(
            tx,
            provider,
            providerUserId,
          );
          const now = new Date();
          await tx
            .update(linkedAccounts)
            .set({
              unlinkedAt: now,
              unlinkReason: "relinked",
              version: displacedVersion,
              updatedAt: now,
            })
            .where(eq(linkedAccounts.id, live.id));
          previous = {
            contactId: live.contactId,
            version: String(displacedVersion),
            owner: await readOwner(tx, live.contactId),
          };
        }

        // (3) The version for the new row — inside the lock, in SQL. On a
        // relink the MAX now includes the displaced row's fresh N+1, so this
        // yields N+2.
        const version = await nextVersion(tx, provider, providerUserId);
        const [inserted] = await tx
          .insert(linkedAccounts)
          .values({
            contactId: input.contactId,
            provider,
            providerUserId,
            username: identity.username ?? null,
            verifiedEmail: identity.verifiedEmail ?? null,
            avatarUrl: identity.avatarUrl ?? null,
            // No token declaration ⇒ tokens are DROPPED, not stored, even if
            // the identity carried them.
            tokens:
              input.storeTokens && identity.tokens
                ? await sealTokens(identity.tokens)
                : null,
            method: input.method,
            singleton: !input.multiple,
            version,
            ...(input.linkedAt ? { linkedAt: input.linkedAt } : {}),
          })
          .returning();
        if (!inserted) throw new Error("link insert returned no row");

        // (6) The owner read, still inside the transaction (DECISIONS §15.5).
        const owner = await readOwner(tx, input.contactId);
        return {
          kind: "written",
          row: inserted,
          owner,
          previous,
          replacedSingleton,
        };
      });
    },
  );

  if (outcome.kind === "rejected") {
    return {
      status: "rejected",
      reason: outcome.reason,
      ...(outcome.currentOwnerContactId
        ? { currentOwnerContactId: outcome.currentOwnerContactId }
        : {}),
    };
  }

  if (outcome.kind === "unchanged") {
    // No hooks, no emission: nothing transitioned.
    const record = toLinkedAccountRecord(outcome.row);
    return {
      status: "unchanged",
      row: record,
      version: record.version,
      owner: outcome.owner,
    };
  }

  const record = toLinkedAccountRecord(outcome.row);
  const at = record.linkedAt.toISOString();
  const hookMeta = { provider, providerUserId };

  // Post-commit, AFTER db.transaction() resolved — never inside it, or a hook
  // that reads the pull plane sees a snapshot that may still roll back.
  // `afterUnlink` for displaced rows FIRST, then `afterLink` for the new row,
  // mirroring the outbound event order (DECISIONS §5).
  //
  // `beforeLink` is DELIBERATELY not invoked anywhere in this module — it is
  // PRD 07's pre-write veto. Moving it here would run it after the
  // transaction opened, holding the pair lock across a customer's network
  // call.
  if (outcome.replacedSingleton) {
    const r = outcome.replacedSingleton;
    const ctx: AfterUnlinkContext = {
      provider: r.provider,
      providerUserId: r.providerUserId,
      contactId: r.contactId,
      userId: r.owner.userId,
      email: r.owner.email,
      reason: "relinked",
      version: r.version,
      at,
    };
    await invokeAfterHook(
      "afterUnlink",
      input.hooks?.afterUnlink && (() => input.hooks?.afterUnlink?.(ctx)),
      input.logger,
      { provider: r.provider, providerUserId: r.providerUserId },
    );
  }
  if (outcome.previous) {
    const p = outcome.previous;
    const ctx: AfterUnlinkContext = {
      provider,
      providerUserId,
      contactId: p.contactId,
      userId: p.owner.userId,
      email: p.owner.email,
      reason: "relinked",
      version: p.version,
      at,
    };
    await invokeAfterHook(
      "afterUnlink",
      input.hooks?.afterUnlink && (() => input.hooks?.afterUnlink?.(ctx)),
      input.logger,
      hookMeta,
    );
  }
  {
    const ctx: AfterLinkContext = {
      provider,
      identity,
      contactId: input.contactId,
      userId: outcome.owner.userId,
      email: outcome.owner.email,
      method: input.method,
      relink: outcome.previous !== null,
      version: record.version,
      at,
      ...(outcome.previous
        ? { currentOwnerContactId: outcome.previous.contactId }
        : {}),
    };
    await invokeAfterHook(
      "afterLink",
      input.hooks?.afterLink && (() => input.hooks?.afterLink?.(ctx)),
      input.logger,
      hookMeta,
    );
  }

  if (outcome.previous) {
    return {
      status: "relinked",
      row: record,
      relink: true,
      version: record.version,
      owner: outcome.owner,
      previous: outcome.previous,
      ...(outcome.replacedSingleton
        ? { replacedSingleton: outcome.replacedSingleton }
        : {}),
    };
  }
  return {
    status: "linked",
    row: record,
    relink: false,
    version: record.version,
    owner: outcome.owner,
    ...(outcome.replacedSingleton
      ? { replacedSingleton: outcome.replacedSingleton }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// unlinkAccount (public) + unlinkAccountInTx (PRD 03 T3b)
// ---------------------------------------------------------------------------

/**
 * The soft-unlink core, run inside SOME transaction under the pair lock:
 * probe → `expectContactId` guard (INSIDE the lock, after the probe — the
 * whole point of the guard) → version bump → soft-unlink UPDATE → owner read.
 */
async function unlinkCore(
  tx: Tx,
  opts: {
    provider: string;
    providerUserId: string;
    reason: "player" | "api" | "relinked";
    expectContactId?: string;
    /** When set, the live row must BE this row or the unlink is `not_found`. */
    expectRowId?: string;
  },
): Promise<
  | { status: "unlinked"; row: LinkedAccountRow; owner: LinkOwner }
  | { status: "not_found" }
  | { status: "rejected"; reason: "not_owner"; currentOwnerContactId: string }
> {
  await lockPairs(tx, [pairLockKey(opts.provider, opts.providerUserId)]);

  const [live] = await tx
    .select()
    .from(linkedAccounts)
    .where(
      and(
        eq(linkedAccounts.provider, opts.provider),
        eq(linkedAccounts.providerUserId, opts.providerUserId),
        isNull(linkedAccounts.unlinkedAt),
      ),
    )
    .limit(1);

  if (!live) return { status: "not_found" };
  if (opts.expectRowId && live.id !== opts.expectRowId) {
    return { status: "not_found" };
  }
  // Evaluated INSIDE the pair lock, after the live-owner probe: a caller that
  // compares in application code has a window in which a hosted callback
  // relinks the pair, and contact A's revoke then destroys contact B's
  // just-proven link.
  if (opts.expectContactId && live.contactId !== opts.expectContactId) {
    return {
      status: "rejected",
      reason: "not_owner",
      currentOwnerContactId: live.contactId,
    };
  }

  const version = await nextVersion(tx, opts.provider, opts.providerUserId);
  const now = new Date();
  const [updated] = await tx
    .update(linkedAccounts)
    .set({
      unlinkedAt: now,
      unlinkReason: opts.reason,
      version,
      updatedAt: now,
    })
    .where(eq(linkedAccounts.id, live.id))
    .returning();
  if (!updated) throw new Error("unlink update returned no row");

  const owner = await readOwner(tx, live.contactId);
  return { status: "unlinked", row: updated, owner };
}

export async function unlinkAccount(
  input: UnlinkAccountInput,
): Promise<UnlinkAccountResult> {
  const outcome = await withVersionRaceRetry(
    {
      provider: input.provider,
      providerUserId: input.providerUserId,
      logger: input.logger,
    },
    () =>
      input.db.transaction((tx) =>
        unlinkCore(tx, {
          provider: input.provider,
          providerUserId: input.providerUserId,
          reason: input.reason,
          expectContactId: input.expectContactId,
        }),
      ),
  );

  if (outcome.status !== "unlinked") return outcome;

  const record = toLinkedAccountRecord(outcome.row);

  // Best-effort provider-side token revoke, post-commit (DECISIONS §10). The
  // sealed blob is unsealed here and handed to the caller's `revoke` wire —
  // never logged, never returned.
  if (input.revoke && outcome.row.tokens) {
    try {
      const tokens = unsealJson(
        outcome.row.tokens,
        await getAppSecret(),
        `account-link:${input.provider}`,
      ) as LinkTokens;
      await input.revoke(tokens);
    } catch (err) {
      input.logger?.warn("accountLink token revoke failed", {
        provider: input.provider,
        providerUserId: input.providerUserId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const at = (outcome.row.unlinkedAt ?? new Date()).toISOString();
  const ctx: AfterUnlinkContext = {
    provider: input.provider,
    providerUserId: input.providerUserId,
    contactId: outcome.row.contactId,
    userId: outcome.owner.userId,
    email: outcome.owner.email,
    reason: input.reason,
    version: record.version,
    at,
  };
  await invokeAfterHook(
    "afterUnlink",
    input.hooks?.afterUnlink && (() => input.hooks?.afterUnlink?.(ctx)),
    input.logger,
    { provider: input.provider, providerUserId: input.providerUserId },
  );

  return {
    status: "unlinked",
    row: record,
    version: record.version,
    owner: outcome.owner,
  };
}

/**
 * Transaction-scoped unlink, for a caller that ALREADY holds a transaction.
 * Its ONLY caller outside this module is PRD 04's contact merge, which holds
 * contact-key advisory locks and therefore cannot call the public
 * `unlinkAccount`: on a different connection it blocks forever on the merge's
 * row locks, and on the same connection it nests (DECISIONS §7).
 *
 * Takes the pair lock RE-ENTRANTLY (advisory xact locks are re-entrant within
 * one transaction), bumps the version with the same
 * `COALESCE(MAX(version), 0) + 1`, soft-unlinks. It does NOTHING else: no
 * transaction of its own, no hooks, no outbound events, no token revoke. Its
 * lifecycle is the caller's, so a caller rollback erases it.
 *
 * The public `unlinkAccount` is a thin wrapper opening the transaction and
 * adding the hook/revoke posture around the same core.
 */
export async function unlinkAccountInTx(
  tx: Tx,
  opts: {
    rowId: string;
    provider: string;
    providerUserId: string;
    reason: "player" | "api" | "relinked";
    /** Same guard as the public entry point, evaluated under the pair lock. */
    expectContactId?: string;
  },
): Promise<UnlinkAccountInTxResult> {
  const outcome = await unlinkCore(tx, {
    provider: opts.provider,
    providerUserId: opts.providerUserId,
    reason: opts.reason,
    expectContactId: opts.expectContactId,
    expectRowId: opts.rowId,
  });
  if (outcome.status !== "unlinked") return outcome;
  return {
    status: "unlinked",
    version: String(outcome.row.version),
    owner: outcome.owner,
  };
}

/**
 * One unlink the contact-deletion leg performed (PRD 04 T5). The facts PRD 08
 * needs to emit `account.unlinked` post-commit without re-reading the
 * database. `version` is a STRING end to end (DECISIONS §5.1).
 */
export interface ContactUnlinkFact {
  provider: string;
  providerUserId: string;
  version: string;
  contactId: string;
  owner: LinkOwner;
  reason: "api";
}

/**
 * Soft-unlink EVERY live link a contact holds, inside the caller's transaction.
 * The caller is contact deletion: `softDeleteContact` and the admin delete
 * route. Nothing in this repo hard-deletes a contact, so without this a live
 * link outlives its owner forever — the pair stays owned by a dead contact, and
 * under `onConflict: "reject"` an erased player can NEVER relink their own
 * platform account (DECISIONS §15.3). Each row gets its own pair's next version
 * under that pair's advisory lock, exactly like the merge leg, so a consumer's
 * monotonic guard accepts the unlink.
 *
 * The token blob is HARD-deleted on the unlinked rows unconditionally: a
 * sealed grant belonging to a deleted person is retained secret material with
 * no owner to revoke it. When `erase` is set (the admin delete route, which
 * also deletes identity aliases), the personal display fields
 * (`verified_email`, `username`, `avatar_url`) are nulled on EVERY row for the
 * contact, live and historical — the version sequence survives erasure so the
 * pair stays monotonic; the personal data does not.
 *
 * ALL pair locks are taken sorted+deduped BEFORE the first mutation (the same
 * deadlock rule as `linkAccount`'s two-pair replace: a delete can touch many
 * pairs at once). Idempotent by construction: a second call finds no live rows
 * and returns an empty array. Opens no transaction, invokes no hook, emits
 * nothing — its lifecycle is the caller's.
 */
export async function unlinkAccountsForContactInTx(
  tx: Tx,
  contactId: string,
  opts: { reason: "api"; erase?: boolean },
): Promise<ContactUnlinkFact[]> {
  const liveRows = await tx
    .select({
      id: linkedAccounts.id,
      provider: linkedAccounts.provider,
      providerUserId: linkedAccounts.providerUserId,
    })
    .from(linkedAccounts)
    .where(
      and(
        eq(linkedAccounts.contactId, contactId),
        isNull(linkedAccounts.unlinkedAt),
      ),
    );

  await lockPairs(
    tx,
    liveRows.map((r) => pairLockKey(r.provider, r.providerUserId)),
  );

  const facts: ContactUnlinkFact[] = [];
  const unlinkedIds: string[] = [];
  for (const row of liveRows) {
    const outcome = await unlinkCore(tx, {
      provider: row.provider,
      providerUserId: row.providerUserId,
      reason: opts.reason,
      // A pair that mutated between the read above and the lock (unlinked,
      // or relinked to a NEW row) is legitimately not ours anymore — skip it
      // rather than unlink someone else's just-proven link.
      expectRowId: row.id,
      expectContactId: contactId,
    });
    if (outcome.status !== "unlinked") continue;
    unlinkedIds.push(outcome.row.id);
    facts.push({
      provider: row.provider,
      providerUserId: row.providerUserId,
      // BigInt → String is lossless; never Number()/parseInt (DECISIONS §5.1).
      version: String(outcome.row.version),
      contactId,
      owner: outcome.owner,
      reason: opts.reason,
    });
  }

  if (unlinkedIds.length > 0) {
    await tx
      .update(linkedAccounts)
      .set({ tokens: null, updatedAt: new Date() })
      .where(inArray(linkedAccounts.id, unlinkedIds));
  }

  if (opts.erase) {
    await tx
      .update(linkedAccounts)
      .set({
        tokens: null,
        verifiedEmail: null,
        username: null,
        avatarUrl: null,
        updatedAt: new Date(),
      })
      .where(eq(linkedAccounts.contactId, contactId));
  }

  return facts;
}

// ---------------------------------------------------------------------------
// Read helpers (PRD 09's routes call these; they never hand-roll a query)
// ---------------------------------------------------------------------------

export async function getLiveLink(opts: {
  db: Database;
  provider: string;
  providerUserId: string;
}): Promise<LinkedAccountRecord | null> {
  const [row] = await opts.db
    .select()
    .from(linkedAccounts)
    .where(
      and(
        eq(linkedAccounts.provider, opts.provider),
        eq(linkedAccounts.providerUserId, opts.providerUserId),
        isNull(linkedAccounts.unlinkedAt),
      ),
    )
    .limit(1);
  return row ? toLinkedAccountRecord(row) : null;
}

export async function listLiveLinksForContact(opts: {
  db: Database;
  contactId: string;
}): Promise<LinkedAccountRecord[]> {
  const rows = await opts.db
    .select()
    .from(linkedAccounts)
    .where(
      and(
        eq(linkedAccounts.contactId, opts.contactId),
        isNull(linkedAccounts.unlinkedAt),
      ),
    )
    .orderBy(linkedAccounts.provider, linkedAccounts.providerUserId);
  return rows.map(toLinkedAccountRecord);
}

/**
 * The pull plane's list read (PRD 09 T3): live links filtered by contact
 * and/or provider, NEWEST FIRST, paginated. Strongly consistent by
 * construction — it reads the live row, never a cached mirror (DECISIONS
 * §3.2).
 *
 * At least one of `contactId` / `provider` is always supplied by the route
 * (the no-filter request is a 400 there, not a full-table scan here), but this
 * function does not enforce that: it is a read helper, and a caller that wants
 * every live link is asking a legitimate question with a bounded `limit`.
 */
export async function listLiveLinks(opts: {
  db: Database;
  contactId?: string;
  provider?: string;
  limit?: number;
  offset?: number;
}): Promise<LinkedAccountRecord[]> {
  const rows = await opts.db
    .select()
    .from(linkedAccounts)
    .where(
      and(
        isNull(linkedAccounts.unlinkedAt),
        ...(opts.contactId
          ? [eq(linkedAccounts.contactId, opts.contactId)]
          : []),
        ...(opts.provider ? [eq(linkedAccounts.provider, opts.provider)] : []),
      ),
    )
    .orderBy(desc(linkedAccounts.linkedAt), desc(linkedAccounts.id))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0);
  return rows.map(toLinkedAccountRecord);
}

export async function listLinkHistory(opts: {
  db: Database;
  provider: string;
  providerUserId: string;
}): Promise<LinkedAccountRecord[]> {
  const rows = await opts.db
    .select()
    .from(linkedAccounts)
    .where(
      and(
        eq(linkedAccounts.provider, opts.provider),
        eq(linkedAccounts.providerUserId, opts.providerUserId),
      ),
    )
    .orderBy(desc(linkedAccounts.version));
  return rows.map(toLinkedAccountRecord);
}
