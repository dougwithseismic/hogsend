/**
 * `createHogsend(config) → Hogsend` — wires the spine, identity, store, and
 * preferences into the public client. The store reference is stable for the
 * client's lifetime; React reads slices via `useSyncExternalStore`.
 */

import type { BannerClient } from "./banner/index.js";
import { createBannerClient } from "./banner/index.js";
import { resolveConfig } from "./config.js";
import type { FeedClient, FeedFetchOptions } from "./feed/index.js";
import { createFeedClient } from "./feed/index.js";
import { createIdentityStore } from "./identity/identity-store.js";
import { createPreferencesClient } from "./preferences/index.js";
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

    feed: (feedId = "in_app", opts?: FeedFetchOptions): FeedClient =>
      createFeedClient(feedId, opts),
    preferences: () => preferencesClient,
    banners: (slot = "default"): BannerClient => createBannerClient(slot),

    connect: () => {
      // v2: lazily open the realtime transport. No-op in v1.
    },
    teardown: () => {
      spine.teardown();
    },
    subscribe: (listener) => store.subscribe(listener),
    getSnapshot: () => store.getSnapshot(),
    store,
  };
}
