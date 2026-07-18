/**
 * Feed client — v2. Speaks the engine's real `/v1/feed/*` contract: lists
 * recipient-scoped items (identity resolved server-side from userToken/anon),
 * marks items (optimistic store patch → POST → `inapp.*` capture sharing the
 * SERVER's idempotency key so the closed loop fires exactly once), and exposes
 * the byId-backed feed-store slice that `@hogsend/react` selects against.
 */

import type { IdentityStore } from "../identity/identity-store.js";
import type { EventSpine } from "../spine/event-spine.js";
import type { Query, Transport } from "../spine/transport.js";
import type { Store } from "../store/external-store.js";
import type { FeedSliceState, HogsendState } from "../types.js";

/**
 * A typed content block in a feed item. Mirrors the engine/db `FeedBlock` union
 * (the authoring authority in `sendFeedItem`); the wire serializes blocks as
 * opaque objects, so this union is advisory — read unknown kinds defensively.
 */
export type FeedBlock =
  | { type: "text"; text: string }
  | { type: "button"; label: string; url: string }
  | { type: "image"; url: string; alt?: string }
  | {
      type: "survey";
      /** Consumer event emitted on answer (reserved-namespace rules apply). */
      event: string;
      mode: "scale" | "nps" | "yesno" | "choice";
      /** Scalar key written into the event. Default `"value"`. */
      property?: string;
      surveyId?: string;
      prompt?: string;
      /** scale/nps bounds (nps forces 0..10). */
      min?: number;
      max?: number;
      minLabel?: string;
      maxLabel?: string;
      /** choice/yesno options. */
      choices?: { label: string; value: string | number }[];
    };

/** Lifecycle status of a single feed item. */
export type FeedItemStatus = "unseen" | "seen" | "read" | "archived";

/**
 * A single notification feed item — the engine `serializeFeedItem` shape.
 * `blocks` is typed as opaque objects to match the wire exactly (the engine
 * serializes `Record<string, unknown>[]`); narrow with {@link FeedBlock}.
 */
export interface FeedItem {
  id: string;
  type: string;
  title: string | null;
  body: string | null;
  blocks: Record<string, unknown>[] | null;
  actionUrl: string | null;
  metadata: Record<string, unknown> | null;
  /** The feed bucket (engine `category`); default "in_app". */
  category: string;
  status: FeedItemStatus;
  seenAt: string | null;
  readAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
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
  /** Custom feed-view filter seam (no backend support yet; reserved). */
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
  /** Re-fetch the first page (reflects cross-tab marks). */
  refetch(): Promise<{
    items: FeedItem[];
    pageInfo: FeedPageInfo;
    metadata: FeedMetadata;
  }>;
  markAsSeen(ids: string[]): Promise<void>;
  markAsRead(ids: string[]): Promise<void>;
  markAsArchived(ids: string[]): Promise<void>;
  markAsUnseen(ids: string[]): Promise<void>;
  markAsUnread(ids: string[]): Promise<void>;
  markAllAsSeen(): Promise<void>;
  markAllAsRead(): Promise<void>;
  markAllAsArchived(): Promise<void>;
  /** Subscribe to realtime feed updates. */
  on(event: "items" | "metadata", listener: () => void): () => void;
  /** The reactive store the feed slice lives in. */
  readonly store: Store<HogsendState>;
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/** The engine `GET /v1/feed` envelope. */
interface ListResponse {
  items: FeedItem[];
  pageInfo: FeedPageInfo;
  metadata: FeedMetadata;
}

/**
 * A realtime-pushed item is partial — `sendFeedItem` publishes only
 * `id/type/title/body/blocks/actionUrl/metadata/category/status/createdAt`
 * (no `updatedAt`, no lifecycle `*At`). Normalize to a full {@link FeedItem}.
 */
type PartialFeedItem = Partial<FeedItem> &
  Pick<FeedItem, "id" | "type" | "status" | "createdAt" | "category">;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Identity params for a feed READ query or WRITE body (same resolution). A
 * publishable caller is honored only via `userToken` (identified) or
 * `anonymousId` (anon); raw `userId`/`email` are secret-key-only and ignored
 * from a pk_ caller, so we send the token when present, else the anon id.
 * `Record<string, string>` is assignable to {@link Query}, so one helper
 * serves both the listQuery spread and the mark/mark-all body spread.
 */
export function identityParams(
  identity: IdentityStore,
): Record<string, string> {
  const userToken = identity.getUserToken();
  const userId = identity.getUserId();
  if (userId && userToken) return { userToken };
  return { anonymousId: identity.getAnonymousId() };
}

// ---------------------------------------------------------------------------
// Feed-store slice (byId map + stable order array)
// ---------------------------------------------------------------------------

const EMPTY_METADATA: FeedMetadata = {
  total_count: 0,
  unseen_count: 0,
  unread_count: 0,
};
const EMPTY_PAGE_INFO: FeedPageInfo = {
  before: null,
  after: null,
  hasNextPage: false,
};

function emptySlice(): FeedSliceState {
  return {
    byId: {},
    order: [],
    pageInfo: EMPTY_PAGE_INFO,
    metadata: EMPTY_METADATA,
  };
}

/** The `inapp.*` event name + optimistic store patch for a mark state. */
function markStateToClient(state: MarkState): {
  eventType: string;
  patch: Partial<FeedItem>;
} {
  const now = new Date().toISOString();
  switch (state) {
    case "seen":
      return {
        eventType: "inapp.item_seen",
        patch: { status: "seen", seenAt: now, updatedAt: now },
      };
    case "read":
      return {
        eventType: "inapp.item_read",
        patch: { status: "read", readAt: now, seenAt: now, updatedAt: now },
      };
    case "archived":
      return {
        eventType: "inapp.item_archived",
        patch: { status: "archived", archivedAt: now, updatedAt: now },
      };
    case "unseen":
      return {
        eventType: "inapp.item_unseen",
        patch: { status: "unseen", seenAt: null, readAt: null, updatedAt: now },
      };
    case "unread":
      // Virtual: status stays `seen`, clear readAt (mirrors the server).
      return {
        eventType: "inapp.item_unread",
        patch: { status: "seen", readAt: null, updatedAt: now },
      };
  }
}

/** Derive `unread_count` from a byId map: status IN (unseen, seen). */
function deriveCounts(byId: Record<string, FeedItem>): FeedMetadata {
  let total = 0;
  let unseen = 0;
  let unread = 0;
  for (const item of Object.values(byId)) {
    total += 1;
    if (item.status === "unseen") unseen += 1;
    if (item.status === "unseen" || item.status === "seen") unread += 1;
  }
  return { total_count: total, unseen_count: unseen, unread_count: unread };
}

/**
 * The feed-store: owns one slice keyed by `feedId` in the shared external
 * store, with a `byId` map for O(1) patches + a stable `order` array. Item +
 * metadata listeners drive `FeedClient.on(...)`.
 */
export function createFeedStore(store: Store<HogsendState>, feedId: string) {
  const itemListeners = new Set<() => void>();
  const metaListeners = new Set<() => void>();

  function slice(): FeedSliceState {
    return store.getSnapshot().feeds?.[feedId] ?? emptySlice();
  }

  function write(next: FeedSliceState): void {
    store.setState((prev) => ({
      ...prev,
      feeds: { ...prev.feeds, [feedId]: next },
    }));
  }

  function emitItems(): void {
    for (const l of itemListeners) l();
  }
  function emitMeta(): void {
    for (const l of metaListeners) l();
  }

  /** Build the createdAt-desc order from the byId map. */
  function reorder(byId: Record<string, FeedItem>): string[] {
    return Object.values(byId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((i) => i.id);
  }

  return {
    /** Replace page 1: byId/order seeded from `items`, plus pageInfo+metadata. */
    setPage(
      items: FeedItem[],
      pageInfo: FeedPageInfo,
      metadata: FeedMetadata,
    ): void {
      const byId: Record<string, FeedItem> = {};
      for (const item of items) byId[item.id] = item;
      write({ byId, order: items.map((i) => i.id), pageInfo, metadata });
      emitItems();
      emitMeta();
    },

    /** Append a page (fetchNextPage): merge new items, keep server metadata. */
    appendPage(items: FeedItem[], pageInfo: FeedPageInfo): void {
      const cur = slice();
      const byId = { ...cur.byId };
      for (const item of items) byId[item.id] = item;
      write({
        byId,
        order: reorder(byId),
        pageInfo,
        metadata: cur.metadata,
      });
      emitItems();
    },

    /** Merge realtime/poll items (upsert) and recompute derived counts. */
    upsert(items: FeedItem[]): void {
      if (items.length === 0) return;
      const cur = slice();
      const byId = { ...cur.byId };
      let changed = false;
      for (const item of items) {
        if (byId[item.id] !== item) changed = true;
        byId[item.id] = item;
      }
      if (!changed) return;
      write({
        byId,
        order: reorder(byId),
        pageInfo: cur.pageInfo,
        metadata: deriveCounts(byId),
      });
      emitItems();
      emitMeta();
    },

    /** Replace metadata counters wholesale (e.g. from a poll snapshot). */
    setMetadata(metadata: FeedMetadata): void {
      const cur = slice();
      if (
        cur.metadata.total_count === metadata.total_count &&
        cur.metadata.unseen_count === metadata.unseen_count &&
        cur.metadata.unread_count === metadata.unread_count
      ) {
        return;
      }
      write({ ...cur, metadata });
      emitMeta();
    },

    /** Optimistically patch a set of ids, recomputing derived counts. */
    patchItems(ids: string[], patch: Partial<FeedItem>): void {
      const cur = slice();
      const byId = { ...cur.byId };
      let changed = false;
      for (const id of ids) {
        const existing = byId[id];
        if (!existing) continue;
        byId[id] = { ...existing, ...patch };
        changed = true;
      }
      if (!changed) return;
      write({
        byId,
        order: cur.order,
        pageInfo: cur.pageInfo,
        metadata: deriveCounts(byId),
      });
      emitItems();
      emitMeta();
    },

    /** Optimistically patch ALL items (mark-all), recomputing counts. */
    patchAll(patch: Partial<FeedItem>): void {
      const cur = slice();
      const entries = Object.entries(cur.byId);
      if (entries.length === 0) return;
      const byId: Record<string, FeedItem> = {};
      for (const [id, item] of entries) byId[id] = { ...item, ...patch };
      write({
        byId,
        order: cur.order,
        pageInfo: cur.pageInfo,
        metadata: deriveCounts(byId),
      });
      emitItems();
      emitMeta();
    },

    on(event: "items" | "metadata", listener: () => void): () => void {
      const set = event === "items" ? itemListeners : metaListeners;
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
  };
}

/** Normalize a (possibly partial) realtime/poll item to a full FeedItem. */
export function normalizeFeedItem(raw: PartialFeedItem): FeedItem {
  return {
    id: raw.id,
    type: raw.type,
    title: raw.title ?? null,
    body: raw.body ?? null,
    blocks: raw.blocks ?? null,
    actionUrl: raw.actionUrl ?? null,
    metadata: raw.metadata ?? null,
    category: raw.category,
    status: raw.status,
    seenAt: raw.seenAt ?? null,
    readAt: raw.readAt ?? null,
    archivedAt: raw.archivedAt ?? null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt ?? raw.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Feed client
// ---------------------------------------------------------------------------

/** The internal feed-store handle (also wired into realtime by client.ts). */
export type FeedStore = ReturnType<typeof createFeedStore>;

export interface FeedClientOptions {
  feedId: string;
  transport: Transport;
  spine: EventSpine;
  identity: IdentityStore;
  store: Store<HogsendState>;
  fetchOptions?: FeedFetchOptions;
  /**
   * The shared feed-store handle for this feedId. Realtime (poll/SSE) writes to
   * the SAME handle via `client.connect()`, so its `upsert`/`setMetadata` fire
   * the client's `on("items"/"metadata")` listeners. One handle per feedId.
   */
  feedStore: FeedStore;
}

/** Build the feed client over a shared feed-store slice. */
export function createFeedClient(opts: FeedClientOptions): FeedClient {
  const { feedId, transport, spine, identity, store } = opts;
  const fed = opts.feedStore;
  // Last fetch options (so fetchNextPage / refetch reuse the same scope).
  let lastOpts: FeedFetchOptions = opts.fetchOptions ?? {};

  function listQuery(o: FeedFetchOptions): Query {
    return {
      feedId,
      ...(o.status ? { status: o.status } : {}),
      ...(o.before ? { before: o.before } : {}),
      ...(o.after ? { after: o.after } : {}),
      ...(o.pageSize ? { pageSize: o.pageSize } : {}),
      ...identityParams(identity),
    };
  }

  async function fetchPage(o: FeedFetchOptions): Promise<ListResponse> {
    return transport.get<ListResponse>("/v1/feed", listQuery(o));
  }

  async function fetch(o?: FeedFetchOptions): Promise<ListResponse> {
    lastOpts = { ...(opts.fetchOptions ?? {}), ...(o ?? {}) };
    const res = await fetchPage(lastOpts);
    fed.setPage(res.items, res.pageInfo, res.metadata);
    return res;
  }

  async function refetch(): Promise<ListResponse> {
    // Page 1 of the same scope (drop the `before` cursor).
    const { before: _drop, ...rest } = lastOpts;
    return fetch(rest);
  }

  async function fetchNextPage(): Promise<FeedItem[]> {
    const cur = store.getSnapshot().feeds?.[feedId];
    const before = cur?.pageInfo.before ?? undefined;
    if (!before) return [];
    const res = await fetchPage({ ...lastOpts, before });
    fed.appendPage(res.items, res.pageInfo);
    return res.items;
  }

  /** Per-id idempotency key — IDENTICAL to the server's `emitMarkEvents`. */
  function itemKey(id: string, eventType: string): string {
    return `inapp:${feedId}:${id}:${eventType}`;
  }

  async function mark(ids: string[], state: MarkState): Promise<void> {
    if (ids.length === 0) return;
    const { eventType, patch } = markStateToClient(state);
    // (a) optimistic store patch
    fed.patchItems(ids, patch);
    // (b) persist
    await transport.post("/v1/feed/mark", {
      ids,
      state,
      feedId,
      ...identityParams(identity),
    });
    // (c) emit the closed-loop event per id with the SERVER's exact key so the
    // optimistic client capture + the server's emit dedup on idempotencyKey.
    await Promise.all(
      ids.map((id) =>
        spine.capture(
          eventType,
          { feedItemId: id, feedId },
          { idempotencyKey: itemKey(id, eventType) },
        ),
      ),
    );
  }

  async function markAll(state: MarkState): Promise<void> {
    const { eventType, patch } = markStateToClient(state);
    fed.patchAll(patch);
    await transport.post("/v1/feed/mark-all", {
      state,
      feedId,
      ...identityParams(identity),
    });
    if (state === "read") {
      // Special case: mark-all-read emits ONE inapp.feed_cleared (not per-item),
      // keyed `inapp:<feedId>:all:inapp.feed_cleared` — match the server exactly.
      await spine.capture(
        "inapp.feed_cleared",
        { feedId },
        { idempotencyKey: `inapp:${feedId}:all:inapp.feed_cleared` },
      );
    } else {
      const ids = Object.keys(store.getSnapshot().feeds?.[feedId]?.byId ?? {});
      await Promise.all(
        ids.map((id) =>
          spine.capture(
            eventType,
            { feedItemId: id, feedId },
            { idempotencyKey: itemKey(id, eventType) },
          ),
        ),
      );
    }
  }

  return {
    fetch,
    fetchNextPage,
    refetch,
    markAsSeen: (ids) => mark(ids, "seen"),
    markAsRead: (ids) => mark(ids, "read"),
    markAsArchived: (ids) => mark(ids, "archived"),
    markAsUnseen: (ids) => mark(ids, "unseen"),
    markAsUnread: (ids) => mark(ids, "unread"),
    markAllAsSeen: () => markAll("seen"),
    markAllAsRead: () => markAll("read"),
    markAllAsArchived: () => markAll("archived"),
    on: (event, listener) => fed.on(event, listener),
    store,
  };
}
