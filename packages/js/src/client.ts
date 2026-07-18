/**
 * `createHogsend(config) → Hogsend` — wires the spine, identity, store, and
 * the feed/preferences sub-clients into the public client. The store reference
 * is stable for the client's lifetime; React reads slices via
 * `useSyncExternalStore`. `connect()` lazily opens the realtime transport
 * (poll default) and pipes its `onItems`/`onMetadata` into the feed-store.
 */

import {
  ATTRIBUTION_STORAGE_KEY,
  arrivalSignature,
  buildAttributionFields,
  parseAttribution,
  type StoredAttribution,
  toArrivalProperties,
} from "./attribution/index.js";
import type { BannerClient, BannerStore } from "./banner/index.js";
import {
  createBannerClient,
  createBannerStore,
  toBanner,
} from "./banner/index.js";
import { resolveConfig } from "./config.js";
import { startDataLayerBridge } from "./datalayer/index.js";
import type {
  FeedClient,
  FeedFetchOptions,
  FeedItem,
  FeedMetadata,
  FeedStore,
} from "./feed/index.js";
import { createFeedClient, createFeedStore } from "./feed/index.js";
import { createFlagsClient } from "./flags/index.js";
import { createIdentityStore } from "./identity/identity-store.js";
import { resolveStorage } from "./identity/storage.js";
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

  const store = createStore<HogsendState>({
    identity: EMPTY_IDENTITY,
    groups: {},
    flags: {},
  });

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

  // The dataLayer bridge (built after the spine) installs this outbound tap so
  // every captured event can be mirrored onto window.dataLayer. The onCapture
  // hook is wired only when OUTBOUND mirroring is configured (`dataLayer.push`),
  // so every other capture path — including inbound-only `watch` — carries zero
  // bridge overhead.
  let outboundTap:
    | ((event: string, properties: Properties) => void)
    | undefined;
  const spine: EventSpine = createEventSpine({
    transport,
    identity,
    flushOnUnload: resolved.flushOnUnload,
    getGroups: () => store.getSnapshot().groups,
    ...(resolved.dataLayer?.push
      ? { onCapture: (event, properties) => outboundTap?.(event, properties) }
      : {}),
  });

  const preferencesClient: PreferencesClient = createPreferencesClient({
    transport,
    spine,
    identity,
    store,
  });

  // Native feature flags — evaluated server-side for the resolved identity and
  // written into the reactive `flags` slice. Fetch on init and re-fetch on
  // identity change (the resolved `distinctId` flips on identify()/reset()),
  // mirroring how the feed slice refreshes for the current recipient.
  const flagsClient = createFlagsClient({ transport, identity, store });
  void flagsClient.refresh();
  let lastFlagsDistinctId = store.getSnapshot().identity.distinctId;

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

  // Re-evaluate flags when the resolved identity changes (guarded on
  // `distinctId` so unrelated store mutations — feed/group/preference writes —
  // never trigger a refetch). Torn down with the other subscriptions.
  unsubs.push(
    store.subscribe(() => {
      const id = store.getSnapshot().identity.distinctId;
      if (id !== lastFlagsDistinctId) {
        lastFlagsDistinctId = id;
        // Clear synchronously the instant identity flips so the previous
        // user's flags are never readable during the in-flight refetch (or
        // after it, should the refetch fail), then re-evaluate for the new
        // identity.
        flagsClient.clear();
        void flagsClient.refresh();
      }
    }),
  );

  const HS_REF_PARAM = "hs_ref";
  // Grace window for a late-arriving userToken before an auto-captured ref is
  // sent at the anon tier. The engine's stamp is first-write-wins, so sending
  // too early would PERMANENTLY record a known contact as anonymous; hosts
  // that mint the token asynchronously right after init (the secure-mode
  // flow) get this long before the beacon commits to the anon tier.
  const CAPTURE_REF_TOKEN_GRACE_MS = 2000;

  /** Read the `hs_ref` arrival param from the current URL. SSR-safe. */
  function readRef(): string | null {
    if (typeof location === "undefined") return null;
    try {
      return new URL(location.href).searchParams.get(HS_REF_PARAM);
    } catch {
      return null;
    }
  }

  /**
   * Strip `hs_ref` from the URL (replaceState — no navigation, no history
   * entry). Called only AFTER a successful arrive POST: a transport failure
   * keeps the param, so a reload or a manual captureRef() can retry — the
   * engine's first-write-wins stamp makes re-sends harmless.
   */
  function stripRef(): void {
    if (typeof location === "undefined" || typeof history === "undefined") {
      return;
    }
    try {
      const url = new URL(location.href);
      if (!url.searchParams.has(HS_REF_PARAM)) return;
      url.searchParams.delete(HS_REF_PARAM);
      history.replaceState(history.state, "", url.toString());
    } catch {
      // Unparseable URL — leave it; the param is inert.
    }
  }

  async function sendRef(ref: string): Promise<boolean> {
    const userToken = identity.getUserToken();
    try {
      // Token wins (the engine's trust tier for "a KNOWN user arrived");
      // anonymous sessions report their own anon id — provenance only.
      await transport.post("/v1/t/arrive", {
        ref,
        ...(userToken
          ? { userToken }
          : { anonymousId: identity.getAnonymousId() }),
      });
      stripRef();
      return true;
    } catch {
      // A beacon: the engine replies 200 to every semantic outcome, so a
      // failure here is transport-level — keep the URL param and never break
      // the host page over it.
      return false;
    }
  }

  async function captureRef(explicitRef?: string): Promise<boolean> {
    const ref = explicitRef ?? readRef();
    if (!ref) return false;
    return sendRef(ref);
  }

  /**
   * Auto-capture: if a userToken is already held, send immediately at the
   * known-contact tier. Otherwise poll briefly for the host's async token
   * mint (`setUserToken` writes a closure, not the store — no subscription
   * fires) before committing to the anon tier.
   */
  function autoCaptureRef(): void {
    const ref = readRef();
    if (!ref) return;
    if (identity.getUserToken()) {
      void sendRef(ref);
      return;
    }
    const deadline = Date.now() + CAPTURE_REF_TOKEN_GRACE_MS;
    const poll = setInterval(() => {
      if (identity.getUserToken() || Date.now() >= deadline) {
        clearInterval(poll);
        void sendRef(ref);
      }
    }, 100);
  }

  // ── GTM/GA4 dataLayer bridge (opt-in; both directions default off) ──
  // Armed before the init auto-captures so an outbound `campaign.arrived`
  // mirror is not missed, and any pre-existing dataLayer entries replay in.
  if (resolved.dataLayer) {
    unsubs.push(
      startDataLayerBridge({
        config: resolved.dataLayer,
        capture: (event, properties) => {
          void spine.capture(event, properties);
        },
        registerOutbound: (tap) => {
          outboundTap = tap;
        },
      }),
    );
  }

  // Auto-capture on init (default on; inert when the URL carries no hs_ref).
  if (resolved.captureRef) autoCaptureRef();

  // ── Campaign/ad-click attribution (docs/revenue-attribution-plan.md §2) ──
  // Same storage adapter the identity store resolves (localStorage → memory).
  const attributionStorage = resolveStorage(resolved.storage);

  function readStoredAttribution(): StoredAttribution | null {
    const raw = attributionStorage.get(ATTRIBUTION_STORAGE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredAttribution;
    } catch {
      return null;
    }
  }

  /**
   * Fire `campaign.arrived` for an attributed landing (click ID or utm_* in
   * the URL) and persist the set as last-touch. Once per landing signature
   * per session (sessionStorage guard); the ingest idempotencyKey
   * (`campaign-arrival:<anon>:<sig>:<UTC day>`) backstops multi-tab races and
   * caps same-day re-clicks server-side.
   */
  function autoCaptureAttribution(): void {
    if (typeof location === "undefined") return;
    const parsed = parseAttribution(
      location.href,
      typeof document !== "undefined" ? document.referrer : "",
    );
    if (!parsed) return;

    const sig = arrivalSignature(parsed);
    const stored: StoredAttribution = {
      ...parsed,
      capturedAt: new Date().toISOString(),
    };
    // Last-touch: every attributed landing overwrites, even when the event
    // itself dedups — a later form submit should carry the freshest touch.
    attributionStorage.set(ATTRIBUTION_STORAGE_KEY, JSON.stringify(stored));

    try {
      const guardKey = `hs_arrival_${sig}`;
      if (typeof sessionStorage !== "undefined") {
        if (sessionStorage.getItem(guardKey)) return;
        sessionStorage.setItem(guardKey, "1");
      }
    } catch {
      // Session guard unavailable (private mode) — the server key still dedups.
    }

    const day = new Date().toISOString().slice(0, 10);
    void spine.capture("campaign.arrived", toArrivalProperties(parsed), {
      idempotencyKey: `campaign-arrival:${identity.getAnonymousId()}:${sig}:${day}`,
    });
  }

  if (resolved.captureAttribution) autoCaptureAttribution();

  /**
   * Associate the session with a group (`groupType → groupKey`), merging into
   * the reactive `groups` slice. Association-only: no properties argument by
   * design — group PROPERTIES are a secret-key write (`@hogsend/client`).
   */
  function group(groupType: string, groupKey: string): void {
    store.setState((prev) => ({
      ...prev,
      groups: { ...prev.groups, [groupType]: groupKey },
    }));
  }

  /** Clear all group associations. */
  function resetGroups(): void {
    store.setState((prev) => ({ ...prev, groups: {} }));
  }

  /** Read the current group associations. */
  function getGroups(): Record<string, string> {
    return store.getSnapshot().groups;
  }

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
    reset: () => {
      identity.reset();
      // PostHog parity: an identity reset drops group associations too.
      resetGroups();
    },

    group,
    resetGroups,
    getGroups,

    flags: () => flagsClient.getAll(),
    getFlag: (key) => flagsClient.getFlag(key),

    capture: (event, properties, opts) =>
      spine.capture(event, properties, opts),
    flush: () => spine.flush(),
    captureRef,
    getAttributionFields: () =>
      buildAttributionFields(
        readStoredAttribution(),
        identity.getAnonymousId(),
      ),

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
