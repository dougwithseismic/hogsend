/**
 * Realtime transport — the SSE→WS swap seam, plus the two built-in transports.
 *
 * REALITY: the engine `GET /v1/feed/stream` SSE route sits behind the
 * `requirePublishableOrIngest` gate, which reads the pk_ key from the
 * `Authorization` header and (for pk_) requires a matching `Origin` header.
 * A browser `EventSource` can set NEITHER, so SSE is unreachable from a plain
 * browser today. POLL — an interval `GET /v1/feed` over the normal Bearer
 * header — is therefore the WORKING DEFAULT transport (zero backend change).
 * SSE stays implemented behind the same interface as a seam; see the FLAG in
 * `createSseTransport` for the additive query-param-auth follow-up.
 */

import type { FeedItem, FeedMetadata } from "../feed/index.js";
import { normalizeFeedItem } from "../feed/index.js";
import type { IdentityStore } from "../identity/identity-store.js";

/** A realtime channel handle returned by {@link RealtimeTransport.connect}. */
export interface RealtimeChannel {
  /** Register a handler for incoming item batches. */
  onItems(listener: (items: FeedItem[]) => void): () => void;
  /** Register a handler for metadata (counter) updates. */
  onMetadata(listener: (metadata: FeedMetadata) => void): () => void;
  /** Close the channel. */
  close(): void;
}

/**
 * The realtime transport seam. POLL is the v2 working default; SSE is the
 * implemented-but-browser-blocked alternative behind this interface; WebSocket
 * slots in later, untouched.
 */
export interface RealtimeTransport {
  /** Open a channel (e.g. `feed:<recipientKey>`). */
  connect(channel: string): RealtimeChannel;
}

// ---------------------------------------------------------------------------
// Shared listener plumbing
// ---------------------------------------------------------------------------

function makeChannelCore() {
  const itemListeners = new Set<(items: FeedItem[]) => void>();
  const metaListeners = new Set<(metadata: FeedMetadata) => void>();
  return {
    emitItems(items: FeedItem[]): void {
      for (const l of itemListeners) l(items);
    },
    emitMeta(metadata: FeedMetadata): void {
      for (const l of metaListeners) l(metadata);
    },
    onItems(listener: (items: FeedItem[]) => void): () => void {
      itemListeners.add(listener);
      return () => {
        itemListeners.delete(listener);
      };
    },
    onMetadata(listener: (metadata: FeedMetadata) => void): () => void {
      metaListeners.add(listener);
      return () => {
        metaListeners.delete(listener);
      };
    },
  };
}

// ---------------------------------------------------------------------------
// POLL — the working default
// ---------------------------------------------------------------------------

/** Engine `GET /v1/feed` envelope (subset the poller reads). */
interface PollListResponse {
  items: FeedItem[];
  metadata: FeedMetadata;
}

/**
 * A minimal poll-fetch contract the poll transport needs from the SDK: fetch
 * page 1 of `feedId` for the current identity (authed via the Bearer header).
 */
export type PollFetcher = (feedId: string) => Promise<PollListResponse>;

export interface PollTransportOptions {
  /** Page-1 fetch (the SDK injects a transport-bound, identity-bound fetcher). */
  fetch: PollFetcher;
  /** The feed bucket to poll. */
  feedId: string;
  /** Poll interval in ms. Default 12000. */
  intervalMs?: number;
}

const DEFAULT_POLL_MS = 12_000;

/**
 * The poll transport — the working default. Each `connect()` starts an interval
 * that re-fetches page 1 of the feed (over the normal `Authorization: Bearer`
 * header — fully authed today) and pushes items + metadata into the channel.
 * The feed-store upsert is reference-stable, so a poll that returns the same
 * items is a no-op for React.
 */
export function createPollTransport(
  opts: PollTransportOptions,
): RealtimeTransport {
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_MS;

  return {
    connect(_channel: string): RealtimeChannel {
      const core = makeChannelCore();
      let timer: ReturnType<typeof setInterval> | null = null;
      let stopped = false;

      const tick = async (): Promise<void> => {
        if (stopped) return;
        try {
          const res = await opts.fetch(opts.feedId);
          if (stopped) return;
          core.emitItems(res.items.map((i) => normalizeFeedItem(i)));
          core.emitMeta(res.metadata);
        } catch {
          // Best-effort; the next tick retries.
        }
      };

      timer = setInterval(() => void tick(), intervalMs);

      return {
        onItems: core.onItems,
        onMetadata: core.onMetadata,
        close: () => {
          stopped = true;
          if (timer !== null) {
            clearInterval(timer);
            timer = null;
          }
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// SSE — the seam (browser-blocked today; see FLAG)
// ---------------------------------------------------------------------------

export interface SseTransportOptions {
  /** Engine origin, e.g. "https://api.acme.com". */
  apiUrl: string;
  /** The feed bucket to subscribe to (maps to `feedId` / category). */
  feedId: string;
  /** Identity store (supplies userToken / anonymousId for the query). */
  identity: IdentityStore;
  /** Injectable EventSource ctor (SSR/test). Defaults to global EventSource. */
  eventSourceCtor?: typeof EventSource;
}

/** The `item.new` payload `sendFeedItem` publishes on `feed:<recipientKey>`. */
interface FeedStreamEvent {
  type: string;
  item?: FeedItem;
}

/**
 * The built-in SSE transport (seam). Opens `GET /v1/feed/stream?feedId=…` with
 * the identity query and translates `event: feed` frames into item batches.
 *
 * FLAG — BROWSER-BLOCKED TODAY: a native `EventSource` cannot set the
 * `Authorization: Bearer pk_…` header the `requirePublishableOrIngest` gate
 * requires, nor (for pk_) does the gate accept the key from the query string.
 * So a real browser SSE connection 401s. Making this work needs an ADDITIVE,
 * security-reviewed backend change: have the stream-scoped gate ALSO read the
 * pk_ key (and userToken) from query params while keeping EVERY existing check
 * (pk_ prefix, `ingest-public` scope, expiry, AND the per-key Origin allowlist
 * — EventSource DOES send `Origin`, so the fail-closed allowlist survives). The
 * review concern is key-in-query-string leakage (logs/referrer); prefer a
 * short-lived userToken in the query with the key in a cookie. UNTIL THAT
 * SHIPS, POLL is the default and this transport is opt-in for runtimes whose
 * EventSource can set headers (Node/RN polyfills, or a same-origin proxy).
 */
export function createSseTransport(
  opts: SseTransportOptions,
): RealtimeTransport {
  return {
    connect(_channel: string): RealtimeChannel {
      const core = makeChannelCore();
      const Ctor =
        opts.eventSourceCtor ??
        (typeof EventSource !== "undefined" ? EventSource : undefined);

      if (!Ctor) {
        // No EventSource available (SSR / unsupported runtime): inert channel.
        return {
          onItems: core.onItems,
          onMetadata: core.onMetadata,
          close: () => {},
        };
      }

      const userToken = opts.identity.getUserToken();
      const userId = opts.identity.getUserId();
      const url = new URL("/v1/feed/stream", `${opts.apiUrl}/`);
      url.searchParams.set("feedId", opts.feedId);
      if (userId && userToken) {
        url.searchParams.set("userToken", userToken);
      } else {
        url.searchParams.set("anonymousId", opts.identity.getAnonymousId());
      }

      const source = new Ctor(url.toString());
      source.addEventListener("feed", (ev: MessageEvent) => {
        try {
          const parsed = JSON.parse(ev.data) as FeedStreamEvent;
          if (parsed.type === "item.new" && parsed.item) {
            core.emitItems([normalizeFeedItem(parsed.item)]);
          }
        } catch {
          // Ignore malformed frames.
        }
      });
      // `ready`/`ping` frames are no-ops.

      return {
        onItems: core.onItems,
        onMetadata: core.onMetadata,
        close: () => source.close(),
      };
    },
  };
}
