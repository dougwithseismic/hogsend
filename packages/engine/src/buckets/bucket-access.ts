import { bucketMemberships, contacts, type Database } from "@hogsend/db";
import { and, count as countFn, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "../lib/db.js";

/**
 * Hard cap on a single page — mirrors the admin `listMembersRoute` `z.max(100)`.
 * Member access is NEVER an unbounded array; even the iterator pages internally.
 */
const MAX_PAGE = 100;
/** Default page size when the caller does not specify a limit. */
const DEFAULT_PAGE = 50;

/** A serialized active-membership row returned by `members()` / the iterator. */
export interface BucketMemberRow {
  id: string;
  userId: string;
  userEmail: string | null;
  enteredAt: string;
  entryCount: number;
}

/** Supabase-shaped paged result — no throw; failures land in `error`. */
export interface MembersResult {
  data: BucketMemberRow[];
  error: Error | null;
  /**
   * Per-call snapshot total (active, non-deleted, joined to a live contact).
   * NOT a consistent paginated total — under churn it can drift page-to-page.
   * The keyset cursor itself is churn-safe; use `count()` for one authoritative
   * number.
   */
  count: number | null;
  /** Keyset continuation (last row `id`); `null` when the page is exhausted. */
  cursor: string | null;
}

export interface BucketAccessor {
  count(): Promise<{ data: number | null; error: Error | null }>;
  has(userId: string): Promise<{ data: boolean; error: Error | null }>;
  members(opts?: { limit?: number; cursor?: string }): Promise<MembersResult>;
  membersIterator(opts?: {
    pageSize?: number;
  }): AsyncIterableIterator<BucketMemberRow>;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Build the per-bucket member-access surface (`count`/`has`/`members`/iterator).
 *
 * The accessor is constructed at module load (`defineBucket` time), before any
 * container exists, so it defaults to `getDb()` — the same singleton the
 * desugared reaction journeys run on. To honor `overrides.db` in tests, the
 * container re-binds the accessors with a `dbResolver` that returns its own
 * `db`; the `getDb()` default bypasses the container.
 *
 * Every query `innerJoin`s `contacts` on `externalId` and filters
 * `isNull(deletedAt)` on both tables — GDPR parity with every reconcile/admin
 * query. No method throws (except the iterator on a page error); failures are
 * carried in the result's `error`.
 */
export function createBucketAccessor(
  bucketId: string,
  dbResolver: () => Database = getDb,
): BucketAccessor {
  async function count(): Promise<{
    data: number | null;
    error: Error | null;
  }> {
    try {
      const db = dbResolver();
      const rows = await db
        .select({ value: countFn() })
        .from(bucketMemberships)
        .innerJoin(contacts, eq(contacts.externalId, bucketMemberships.userId))
        .where(
          and(
            eq(bucketMemberships.bucketId, bucketId),
            eq(bucketMemberships.status, "active"),
            isNull(bucketMemberships.deletedAt),
            isNull(contacts.deletedAt),
          ),
        );
      return { data: rows[0]?.value ?? 0, error: null };
    } catch (err) {
      return { data: null, error: toError(err) };
    }
  }

  async function has(
    userId: string,
  ): Promise<{ data: boolean; error: Error | null }> {
    try {
      const db = dbResolver();
      // O(1) probe on the partial active unique index (uq_user_bucket_active).
      const rows = await db
        .select({ id: bucketMemberships.id })
        .from(bucketMemberships)
        .innerJoin(contacts, eq(contacts.externalId, bucketMemberships.userId))
        .where(
          and(
            eq(bucketMemberships.bucketId, bucketId),
            eq(bucketMemberships.userId, userId),
            eq(bucketMemberships.status, "active"),
            isNull(bucketMemberships.deletedAt),
            isNull(contacts.deletedAt),
          ),
        )
        .limit(1);
      return { data: rows.length > 0, error: null };
    } catch (err) {
      return { data: false, error: toError(err) };
    }
  }

  async function members(opts?: {
    limit?: number;
    cursor?: string;
  }): Promise<MembersResult> {
    const limit = Math.min(opts?.limit ?? DEFAULT_PAGE, MAX_PAGE);
    try {
      const db = dbResolver();
      const conditions = [
        eq(bucketMemberships.bucketId, bucketId),
        eq(bucketMemberships.status, "active"),
        isNull(bucketMemberships.deletedAt),
        isNull(contacts.deletedAt),
      ];
      // Keyset cursor on `id` (UUID, unique, stable — NOT enteredAt, which ties
      // on defaultNow). Opaque (UUID asc) order, not chronological.
      if (opts?.cursor) {
        conditions.push(gt(bucketMemberships.id, opts.cursor));
      }

      const [rows, totalRows] = await Promise.all([
        db
          .select({
            id: bucketMemberships.id,
            userId: bucketMemberships.userId,
            userEmail: bucketMemberships.userEmail,
            enteredAt: bucketMemberships.enteredAt,
            entryCount: bucketMemberships.entryCount,
          })
          .from(bucketMemberships)
          .innerJoin(
            contacts,
            eq(contacts.externalId, bucketMemberships.userId),
          )
          .where(and(...conditions))
          .orderBy(bucketMemberships.id)
          // +1 peek to detect a next page.
          .limit(limit + 1),
        db
          .select({ value: countFn() })
          .from(bucketMemberships)
          .innerJoin(
            contacts,
            eq(contacts.externalId, bucketMemberships.userId),
          )
          .where(
            and(
              eq(bucketMemberships.bucketId, bucketId),
              eq(bucketMemberships.status, "active"),
              isNull(bucketMemberships.deletedAt),
              isNull(contacts.deletedAt),
            ),
          ),
      ]);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const data: BucketMemberRow[] = page.map((r) => ({
        id: r.id,
        userId: r.userId,
        userEmail: r.userEmail,
        enteredAt: r.enteredAt.toISOString(),
        entryCount: r.entryCount,
      }));
      const cursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

      return {
        data,
        error: null,
        count: totalRows[0]?.value ?? 0,
        cursor,
      };
    } catch (err) {
      return { data: [], error: toError(err), count: null, cursor: null };
    }
  }

  async function* membersIterator(opts?: {
    pageSize?: number;
  }): AsyncIterableIterator<BucketMemberRow> {
    const pageSize = Math.min(opts?.pageSize ?? DEFAULT_PAGE, MAX_PAGE);
    let cursor: string | null | undefined;
    // The only full-population traversal — bounded page-by-page via members().
    while (true) {
      const page = await members({
        limit: pageSize,
        cursor: cursor ?? undefined,
      });
      if (page.error) throw page.error;
      for (const row of page.data) yield row;
      if (!page.cursor) break;
      cursor = page.cursor;
    }
  }

  return { count, has, members, membersIterator };
}
