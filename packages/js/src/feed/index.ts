/**
 * Feed client — v2. The module exists in v1 so the subpath export, types, and
 * the `Hogsend.feed()` signature are stable now; the implementation lands in
 * v2 (feed_items table + /v1/feed routes + SSE). Method SIGNATURES are
 * complete and typecheck; bodies throw a clear "not implemented in v1" Error.
 */

/** A typed content block in a feed item (extensible union; v2 fills kinds). */
export type FeedBlock =
  | { type: "markdown"; content: string }
  | { type: "button"; label: string; url: string }
  | { type: "image"; src: string; alt?: string };

/** Lifecycle status of a single feed item. */
export type FeedItemStatus = "unseen" | "seen" | "read" | "archived";

/** A single notification feed item. */
export interface FeedItem {
  id: string;
  type: string;
  title: string | null;
  body: string | null;
  blocks: FeedBlock[] | null;
  actionUrl: string | null;
  metadata: Record<string, unknown> | null;
  status: FeedItemStatus;
  seenAt: string | null;
  readAt: string | null;
  archivedAt: string | null;
  createdAt: string;
}

/** Aggregate counters for a feed. */
export interface FeedMetadata {
  total_count: number;
  unseen_count: number;
  unread_count: number;
}

/** Cursor pagination info. */
export interface FeedPageInfo {
  before: string | null;
  after: string | null;
  hasNextPage: boolean;
}

/** Options accepted when fetching/scoping a feed. */
export interface FeedFetchOptions {
  pageSize?: number;
  status?: FeedItemStatus | "all";
  before?: string;
  after?: string;
  /** Custom feed-view filter seam (no new endpoint needed). */
  where?: Record<string, unknown>;
}

/** A bulk mark target. */
export type MarkState = "seen" | "read" | "archived" | "unseen" | "unread";

/** The feed sub-client. */
export interface FeedClient {
  fetch(opts?: FeedFetchOptions): Promise<{
    items: FeedItem[];
    pageInfo: FeedPageInfo;
    metadata: FeedMetadata;
  }>;
  fetchNextPage(): Promise<FeedItem[]>;
  markAsSeen(ids: string[]): Promise<void>;
  markAsRead(ids: string[]): Promise<void>;
  markAsArchived(ids: string[]): Promise<void>;
  markAsUnseen(ids: string[]): Promise<void>;
  markAsUnread(ids: string[]): Promise<void>;
  markAllAsSeen(): Promise<void>;
  markAllAsRead(): Promise<void>;
  markAllAsArchived(): Promise<void>;
  /** Subscribe to realtime feed updates (v2). */
  on(event: "items" | "metadata", listener: () => void): () => void;
}

const NOT_IMPLEMENTED =
  "@hogsend/js: feed is not implemented in v1 (lands in v2)";

/** v2 factory placeholder. Throws until v2 wires the feed backend. */
export function createFeedClient(
  _feedId: string,
  _opts?: FeedFetchOptions,
): FeedClient {
  throw new Error(NOT_IMPLEMENTED);
}
