/**
 * `createHogsend(config) → Hogsend` — wires the spine, identity, store, and
 * the feed/preferences sub-clients into the public client. The store reference
 * is stable for the client's lifetime; React reads slices via
 * `useSyncExternalStore`. `connect()` lazily opens the realtime transport
 * (poll default) and pipes its `onItems`/`onMetadata` into the feed-store.
 */

import type { BannerClient, BannerStore } from "./banner/index.js";
import {
  createBannerClient,
  createBannerStore,
  toBanner,
} from "./banner/index.js";
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
import type { ToastClient } from "./toast/index.js";
import { createToastClient } from "./toast/index.js";
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

  const identity = createIdentityStore({
    store,
    ...(resolved.storage ? { storage: resolved.storage } : {}),
    ...(resolved.userId ? { userId: resolved.userId } : {}),
    ...(resolved.userToken ? { userToken: resolved.userToken } : {}),
  });

  // Secure-mode refresh: on a 403 carrying the expired-`userToken` signal, the
  // transport calls this once to mint a fresh token, store it, and retry once.
  const onUnauthorized = resolved.onUserTokenExpiring
    ? async (): Promise<string | null> => {
        const fresh = await resolved.onUserTokenExpiring?.();
        if (fresh) identity.setUserToken(fresh);
        return fresh ?? null;
      }
    : undefined;

  const transport = createTransport({
    auth: {
      baseUrl: resolved.apiUrl,
      publishableKey: resolved.publishableKey,
      ...(resolved.ingestPath ? { ingestPath: resolved.ingestPath } : {}),
      ...(onUnauthorized ? { onUnauthorized } : {}),
      getUserToken: () => identity.getUserToken(),
    },
    ...(resolved.fetch ? { fetch: resolved.fetch } : {}),
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

  // One banner-store + banner-client per slot (mirrors feed()).
  const bannerStores = new Map<string, BannerStore>();
  const bannerClients = new Map<string, BannerClient>();

  function bannerStoreFor(slot: string): BannerStore {
    let bs = bannerStores.get(slot);
    if (!bs) {
      bs = createBannerStore(store, slot);
      bannerStores.set(slot, bs);
    }
    return bs;
  }

  function banners(slot = "default"): BannerClient {
    const existing = bannerClients.get(slot);
    if (existing) return existing;
    const client = createBannerClient({
      slot,
      transport,
      spine,
      identity,
      store,
      bannerStore: bannerStoreFor(slot),
    });
    bannerClients.set(slot, client);
    return client;
  }

  // Lazy ephemeral toast client (singleton; off the persisted store).
  let toastClient: ToastClient | null = null;
  function toasts(): ToastClient {
    if (!toastClient) toastClient = createToastClient({ spine });
    return toastClient;
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
    banners,
    toasts,

    connect: (feedId = DEFAULT_FEED_ID) => {
      if (channels.has(feedId)) return;
      const transportImpl = resolveRealtime(feedId);
      if (!transportImpl) return;
      const isBanner = feedId.startsWith("banner:");
      const channel = transportImpl.connect(`feed:${feedId}`);
      if (isBanner) {
        // Banner channel: project items into the banner-store for this slot.
        const slot = feedId.slice("banner:".length);
        const bs = bannerStoreFor(slot);
        unsubs.push(
          channel.onItems((items) =>
            bs.upsert(items.map((i) => toBanner(i, slot))),
          ),
        );
      } else {
        const fed = feedStoreFor(feedId);
        unsubs.push(
          // Route `type:"toast"` realtime items to the ephemeral toast client
          // (additive — non-toast items still upsert into the feed-store).
          channel.onItems((items) => {
            const toastItems = items.filter((i) => i.type === "toast");
            if (toastItems.length > 0) {
              const tc = toasts();
              for (const i of toastItems) {
                tc.show({
                  id: i.id,
                  type: "toast",
                  title: i.title,
                  body: i.body,
                  actionUrl: i.actionUrl,
                  metadata: i.metadata,
                  ...(typeof i.metadata?.duration === "number"
                    ? { duration: i.metadata.duration }
                    : {}),
                });
              }
            }
            const feedItemsOnly = items.filter((i) => i.type !== "toast");
            if (feedItemsOnly.length > 0) fed.upsert(feedItemsOnly);
          }),
          channel.onMetadata((metadata) => fed.setMetadata(metadata)),
        );
      }
      channels.set(feedId, channel);
    },
    teardown: () => {
      for (const channel of channels.values()) channel.close();
      channels.clear();
      for (const unsub of unsubs.splice(0)) unsub();
      toastClient?.teardown();
      spine.teardown();
    },
    subscribe: (listener) => store.subscribe(listener),
    getSnapshot: () => store.getSnapshot(),
    store,
  };
}
