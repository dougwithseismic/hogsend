/**
 * The preferences client: reads `{ categories, unsubscribedAll }` from the
 * engine, writes opt-in/out over `/v1/lists`, and — critically — emits
 * `inapp.preference_changed` through the spine so a win-back journey can react
 * the day v1 ships. This is the v1 proof of the closed loop.
 */

import type { IdentityStore } from "../identity/identity-store.js";
import type { EventSpine } from "../spine/event-spine.js";
import type { Transport } from "../spine/transport.js";
import type { Store } from "../store/external-store.js";
import type {
  HogsendState,
  PreferencesClient,
  PreferencesState,
} from "../types.js";

/** The `inapp.*` event name emitted when a preference toggles. */
export const PREFERENCE_CHANGED_EVENT = "inapp.preference_changed";

export interface PreferencesClientOptions {
  transport: Transport;
  spine: EventSpine;
  identity: IdentityStore;
  store: Store<HogsendState>;
}

/** Engine response shape for `GET /v1/lists/preferences`. */
interface PreferencesResponse {
  categories?: Record<string, boolean>;
  unsubscribedAll?: boolean;
}

function identityQuery(
  identity: IdentityStore,
): Record<string, string | undefined> {
  const userId = identity.getUserId();
  return userId ? { userId } : { anonymousId: identity.getAnonymousId() };
}

/**
 * Identity for a list WRITE body. Lists require a resolvable email/userId, so
 * an identified write carries `userId` + its signed `userToken` (a publishable
 * key may only act on another identity with the token); anon falls through to
 * `anonymousId` (which the engine rejects — anon contacts can't set list prefs).
 */
function identityBody(identity: IdentityStore): Record<string, string> {
  const userId = identity.getUserId();
  if (!userId) return { anonymousId: identity.getAnonymousId() };
  const userToken = identity.getUserToken();
  return { userId, ...(userToken ? { userToken } : {}) };
}

/** Build the preferences client. */
export function createPreferencesClient(
  opts: PreferencesClientOptions,
): PreferencesClient {
  function writeSlice(next: PreferencesState): void {
    opts.store.setState((prev) => ({ ...prev, preferences: next }));
  }

  async function get(): Promise<PreferencesState> {
    const res = await opts.transport.get<PreferencesResponse>(
      "/v1/lists/preferences",
      identityQuery(opts.identity),
    );
    const state: PreferencesState = {
      categories: res.categories ?? {},
      unsubscribedAll: res.unsubscribedAll ?? false,
    };
    writeSlice(state);
    return state;
  }

  async function emitChange(
    categoryId: string,
    subscribed: boolean,
  ): Promise<void> {
    await opts.spine.capture(PREFERENCE_CHANGED_EVENT, {
      categoryId,
      subscribed,
    });
  }

  return {
    get,
    setPreference: async (categoryId, subscribed) => {
      const path = subscribed
        ? `/v1/lists/${encodeURIComponent(categoryId)}/subscribe`
        : `/v1/lists/${encodeURIComponent(categoryId)}/unsubscribe`;
      await opts.transport.post(path, identityBody(opts.identity));
      // Optimistic local slice update.
      opts.store.setState((prev) => {
        const prefs = prev.preferences ?? {
          categories: {},
          unsubscribedAll: false,
        };
        return {
          ...prev,
          preferences: {
            ...prefs,
            categories: { ...prefs.categories, [categoryId]: subscribed },
          },
        };
      });
      // The structural closed-loop trigger.
      await emitChange(categoryId, subscribed);
    },
    subscribe: async (listId) => {
      await opts.transport.post(
        `/v1/lists/${encodeURIComponent(listId)}/subscribe`,
        identityBody(opts.identity),
      );
      await emitChange(listId, true);
    },
    unsubscribe: async (listId) => {
      await opts.transport.post(
        `/v1/lists/${encodeURIComponent(listId)}/unsubscribe`,
        identityBody(opts.identity),
      );
      await emitChange(listId, false);
    },
  };
}
