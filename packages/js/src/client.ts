/**
 * `createHogsend(config) → Hogsend` — wires the spine, identity, store, and
 * the feed/preferences sub-clients into the public client. The store reference
 * is stable for the client's lifetime; React reads slices via
 * `useSyncExternalStore`. `connect()` lazily opens the realtime transport
 * (poll default) and pipes its `onItems`/`onMetadata` into the feed-store.
 */

import type { BannerClient } from "./banner/index.js";
import { createBannerClient } from "./banner/index.js";
import { resolveConfig } from "./config.js";
import type {
  FeedClient,
  FeedFetchOptions,
  FeedItem,
  FeedMetadata,
  FeedStore,
} from "./feed/index.js";
import { createFeedClient, createFeedStore } from "./feed/index.js";
import { createIdentityStore } from "./identity/identity-store.js";
import { createPreferencesClient } from "./preferences/index.js";
import type { RealtimeChannel, RealtimeTransport } from "./realtime/index.js";
import { createPollTransport, createSseTransport } from "./realtime/index.js";
import { createEventSpine, type EventSpine } from "./spine/event-spine.js";
import { createTransport } from "./spine/transport.js";
import { createStore } from "./store/external-store.js";
import type {
  Hogsend,
  HogsendConfig,
  HogsendState,
  IdentitySlice,
  PreferencesClient,
  Properties,
} from "./types.js";

const EMPTY_IDENTITY: IdentitySlice = {
  distinctId: "",
  userId: null,
  contactKey: null,
  identified: false,
};

const DEFAULT_FEED_ID = "in_app";

/** Create a Hogsend browser client. */
export function createHogsend(config: HogsendConfig): Hogsend {
  const resolved = resolveConfig(config);

  const store = createStore<HogsendState>({ identity: EMPTY_IDENTITY });

  const transport = createTransport({
    auth: {
      baseUrl: resolved.apiUrl,
      publishableKey: resolved.publishableKey,
      ...(resolved.ingestPath ? { ingestPath: resolved.ingestPath } : {}),
    },
    ...(resolved.fetch ? { fetch: resolved.fetch } : {}),
  });

  const identity = createIdentityStore({
    store,
    ...(resolved.storage ? { storage: resolved.storage } : {}),
    ...(resolved.userId ? { userId: resolved.userId } : {}),
    ...(resolved.userToken ? { userToken: resolved.userToken } : {}),
  });

  const spine: EventSpine = createEventSpine({
    transport,
    identity,
    flushOnUnload: resolved.flushOnUnload,
  });

  const preferencesClient: PreferencesClient = createPreferencesClient({
    transport,
    spine,
    identity,
    store,
  });

  // One feed-store + feed-client per feedId (so React's useMemo over feed() is
  // stable and realtime pipes into the SAME slice the client reads).
  const feedStores = new Map<string, FeedStore>();
  const feedClients = new Map<string, FeedClient>();

  function feedStoreFor(feedId: string): FeedStore {
    let fed = feedStores.get(feedId);
    if (!fed) {
      fed = createFeedStore(store, feedId);
      feedStores.set(feedId, fed);
    }
    return fed;
  }

  function feed(feedId = DEFAULT_FEED_ID, opts?: FeedFetchOptions): FeedClient {
    const existing = feedClients.get(feedId);
    if (existing) return existing;
    const client = createFeedClient({
      feedId,
      transport,
      spine,
      identity,
      store,
      feedStore: feedStoreFor(feedId),
      ...(opts ? { fetchOptions: opts } : {}),
    });
    feedClients.set(feedId, client);
    return client;
  }

  // Identity-bound page-1 fetch for the poll transport (Bearer-authed today).
  function pollFetch(
    feedId: string,
  ): Promise<{ items: FeedItem[]; metadata: FeedMetadata }> {
    const userToken = identity.getUserToken();
    const userId = identity.getUserId();
    const idQuery =
      userId && userToken
        ? { userToken }
        : { anonymousId: identity.getAnonymousId() };
    return transport.get("/v1/feed", { feedId, ...idQuery });
  }

  /** Resolve the configured realtime mode to a concrete transport (or null). */
  function resolveRealtime(feedId: string): RealtimeTransport | null {
    const mode = resolved.realtime;
    if (mode === "off") return null;
    if (typeof mode === "object") return mode; // consumer-supplied
    if (mode === "sse") {
      // SSE is browser-blocked today (EventSource can't send Authorization /
      // Origin) — fall back to poll so the default never silently 401s. The
      // SSE seam stays available via an explicit transport object.
      void createSseTransport; // keep the seam referenced/tree-shake-safe
      return createPollTransport({ fetch: pollFetch, feedId });
    }
    // "poll" (and the resolved default)
    return createPollTransport({ fetch: pollFetch, feedId });
  }

  const channels = new Map<string, RealtimeChannel>();
  const unsubs: Array<() => void> = [];

  async function identify(userId: string, traits?: Properties): Promise<void> {
    identity.setUserId(userId);
    const userToken = identity.getUserToken();
    await transport.put("/v1/contacts", {
      userId,
      anonymousId: identity.getAnonymousId(),
      ...(userToken ? { userToken } : {}),
      ...(traits ? { properties: traits } : {}),
    });
  }

  return {
    identify,
    getDistinctId: () => identity.getDistinctId(),
    getContactKey: () => identity.getContactKey(),
    isIdentified: () => identity.isIdentified(),
    reset: () => identity.reset(),

    capture: (event, properties, opts) =>
      spine.capture(event, properties, opts),
    flush: () => spine.flush(),

    feed,
    preferences: () => preferencesClient,
    banners: (slot = "default"): BannerClient => createBannerClient(slot),

    connect: (feedId = DEFAULT_FEED_ID) => {
      if (channels.has(feedId)) return;
      const transportImpl = resolveRealtime(feedId);
      if (!transportImpl) return;
      const fed = feedStoreFor(feedId);
      const channel = transportImpl.connect(`feed:${feedId}`);
      unsubs.push(
        channel.onItems((items) => fed.upsert(items)),
        channel.onMetadata((metadata) => fed.setMetadata(metadata)),
      );
      channels.set(feedId, channel);
    },
    teardown: () => {
      for (const channel of channels.values()) channel.close();
      channels.clear();
      for (const unsub of unsubs.splice(0)) unsub();
      spine.teardown();
    },
    subscribe: (listener) => store.subscribe(listener),
    getSnapshot: () => store.getSnapshot(),
    store,
  };
}
