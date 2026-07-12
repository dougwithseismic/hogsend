/**
 * Public type surface for `@hogsend/js`. The versioned core contract is
 * `createHogsend(config) → Hogsend` plus the store snapshot shapes, the
 * `RealtimeTransport` interface, and the `inapp.*` event union.
 */

import type { Banner, BannerClient } from "./banner/index.js";
import type {
  FeedClient,
  FeedFetchOptions,
  FeedItem,
  FeedMetadata,
  FeedPageInfo,
} from "./feed/index.js";
import type { RealtimeTransport } from "./realtime/index.js";
import type { Store } from "./store/external-store.js";
import type { ToastClient } from "./toast/index.js";

/** A JSON-serializable property bag attached to a captured event. */
export type Properties = Record<string, unknown>;

/**
 * Pluggable storage backend for the identity store. Defaults to
 * `localStorage`, falls back to an in-memory adapter when storage is
 * unavailable (SSR, private mode, native runtimes).
 */
export interface StorageAdapter {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** How the SDK selects/opens its realtime transport. v2 wires the impls. */
export type RealtimeMode = RealtimeTransport | "sse" | "poll" | "off";

/** Configuration for {@link createHogsend}. */
export interface HogsendConfig {
  /** Engine origin, e.g. "https://api.acme.com". */
  apiUrl: string;
  /** Alias for {@link HogsendConfig.apiUrl}. */
  host?: string;
  /** Browser-safe publishable key (`pk_…`). */
  publishableKey: string;
  /** Known user id; omit for anonymous mode. */
  userId?: string;
  /**
   * Optional signed proof of `userId` so a publishable (`pk_`) key may act as
   * that user. Sent as the body `userToken` on every identity-asserting call;
   * the engine verify path is live. A server-side mint helper lands in v3.
   */
  userToken?: string;
  /** Storage backend; defaults to localStorage with a memory fallback. */
  storage?: StorageAdapter;
  /** Injectable fetch (SSR/test). */
  fetch?: typeof fetch;
  /**
   * BYO-proxy fallback: POST telemetry to this absolute URL (the host app's
   * own backend, which holds the secret key and forwards) instead of
   * `apiUrl`/v1/events directly. The transport's auth strategy is a seam.
   */
  ingestPath?: string;
  /** Realtime transport selection. Default "sse" → poll fallback (v2). */
  realtime?: RealtimeMode;
  /** Flush the queue via `sendBeacon` on page unload. Default true. */
  flushOnUnload?: boolean;
  /**
   * Secure mode: called when a data-plane call 403s with an expired/invalid
   * `userToken`. Must return a FRESH token (e.g. re-hit the host server's mint
   * route that calls `generateUserToken`). The SDK stores it and retries the
   * request once.
   */
  onUserTokenExpiring?: () => Promise<string>;
  /**
   * Arrival attribution auto-capture. When the landing URL carries an
   * `hs_ref` param (appended by an opted-in tracked link/QR redirect), the
   * SDK reports it to `POST /v1/t/arrive` with the session's identity
   * (userToken when held, else the anon id) and strips the param from the
   * URL. Default true — inert when no `hs_ref` is present. Set false for
   * SPAs that route before init and call {@link Hogsend.captureRef} manually.
   */
  captureRef?: boolean;
  /**
   * Campaign/ad-click attribution auto-capture. When the landing URL carries
   * an allowlisted click ID (`fbclid`, `gclid`, `ttclid`, …) or any `utm_*`
   * param, the SDK fires ONE `campaign.arrived` event (per landing signature,
   * per session/day) with the params as flat properties, and persists the set
   * as the last-touch attribution readable via
   * {@link Hogsend.getAttributionFields}. Default true — inert on
   * non-campaign pageloads.
   */
  captureAttribution?: boolean;
}

/** Result of a single {@link Hogsend.capture}. */
export interface CaptureResult {
  /** Whether the event was accepted/stored by the engine. */
  stored: boolean;
  /** Canonical contact key from the ingest 202 (for `posthog.identify`). */
  contactKey: string;
}

/** Per-call options for {@link Hogsend.capture}. */
export interface CaptureOptions {
  /** Dedup key threaded into the ingest pipeline's idempotency. */
  idempotencyKey?: string;
  /** ISO timestamp override; defaults to capture time. */
  timestamp?: string;
  /**
   * The event's monetary worth (order total, deal value). First-class on the
   * engine's `user_events.value` revenue column, not a property.
   */
  value?: number;
  /** ISO-4217 alpha code for `value` (3 letters; uppercased at ingest). */
  currency?: string;
}

/** A single list/category the contact can opt in/out of. */
export interface ListSummary {
  id: string;
  name: string;
  description?: string;
  defaultOptIn: boolean;
  subscribed: boolean;
  /**
   * Whether this list is a delivery `channel` (in_app, telegram, discord…) or a
   * content `topic`. OPTIONAL — an older self-hosted engine omits it, so a
   * consumer MUST treat `undefined` as `"topic"`.
   */
  kind?: "channel" | "topic";
}

/** Resolved email/notification preferences for the current identity. */
export interface PreferencesState {
  /** Per-category opt-in map (true = subscribed). */
  categories: Record<string, boolean>;
  /** Global opt-out flag. */
  unsubscribedAll: boolean;
}

/** The preferences sub-client returned by {@link Hogsend.preferences}. */
export interface PreferencesClient {
  /** Fetch current preferences from the engine. */
  get(): Promise<PreferencesState>;
  /**
   * Fetch the list catalog (`GET /v1/lists`) with each list's resolved
   * `subscribed` state for the current identity. Powers the preference center
   * matrix from a single call (a publishable/anon read returns `defaultOptIn`).
   */
  lists(): Promise<ListSummary[]>;
  /**
   * Set a single category preference. Emits `inapp.preference_changed`
   * through the spine — the structural closed-loop trigger.
   */
  setPreference(categoryId: string, subscribed: boolean): Promise<void>;
  /** Subscribe the current identity to a list/category. */
  subscribe(listId: string): Promise<void>;
  /** Unsubscribe the current identity from a list/category. */
  unsubscribe(listId: string): Promise<void>;
  /**
   * Set the global email opt-out (`unsubscribedAll`) for the current identity.
   * POSTs `/v1/lists/preferences`; emits `inapp.preference_changed` with
   * `categoryId: ALL_EMAILS_CATEGORY` (`"$all"`).
   */
  setUnsubscribedAll(unsubscribed: boolean): Promise<void>;
}

/** Identity slice of the reactive store. */
export interface IdentitySlice {
  /** Resolved distinct id (known userId, else persisted anon id). */
  distinctId: string;
  /** Known user id when identified, else null. */
  userId: string | null;
  /** Canonical contact key from the last 202, else null. */
  contactKey: string | null;
  /** Whether a known user id is bound. */
  identified: boolean;
}

/** Color mode slice (driven by the React provider in `@hogsend/react`). */
export type ColorMode = "light" | "dark";

/**
 * Root reactive state. A flat record of optional slices; each surface owns its
 * own slice. v1 populates `identity` and `preferences`; `feeds`/`banners` are
 * declared for v2/v3 and remain undefined until those surfaces wire in.
 */
export interface HogsendState {
  identity: IdentitySlice;
  preferences?: PreferencesState;
  /** Keyed by feedId (v2). */
  feeds?: Record<string, FeedSliceState>;
  /** Keyed by slot (v3). */
  banners?: Record<string, BannerSliceState>;
}

/**
 * Feed slice shape (v2). A `byId` map gives O(1) item patches with stable
 * identity, and a `order` array (createdAt-desc id list) gives the React
 * selector a STABLE reference to subscribe to — `items[]` is derived OUTSIDE
 * the selector from `order.map(id => byId[id])` (the infinite-loop guard).
 */
export interface FeedSliceState {
  /** O(1) item lookup/patch, keyed by `item.id`. */
  byId: Record<string, FeedItem>;
  /** createdAt-desc id list; stable array → derive `items[]` outside selectors. */
  order: string[];
  /** Cursor pagination info from the last fetch. */
  pageInfo: FeedPageInfo;
  /** Aggregate counters (`total_count`/`unseen_count`/`unread_count`). */
  metadata: FeedMetadata;
}

/**
 * Banner slice shape (v3). A `byId` map gives O(1) patches with stable
 * identity; a priority/createdAt-desc `order` array gives the React selector a
 * STABLE reference — the visible (non-dismissed) array is derived OUTSIDE the
 * selector (the infinite-loop guard), mirroring {@link FeedSliceState}.
 */
export interface BannerSliceState {
  /** O(1) banner lookup/patch, keyed by `banner.id`. */
  byId: Record<string, Banner>;
  /** priority/createdAt-desc id list; stable array → derive arrays outside selectors. */
  order: string[];
}

/** The browser core client. */
export interface Hogsend {
  // ── identity ──
  identify(userId: string, traits?: Properties): Promise<void>;
  /** Known userId, else the persisted anon id. */
  getDistinctId(): string;
  /** Canonical key from the last 202 (for `posthog.identify`, zero PII). */
  getContactKey(): string | null;
  isIdentified(): boolean;
  /** Logout: mint a new anon id, drop the known id. */
  reset(): void;

  // ── the spine (single telemetry path) ──
  capture(
    event: string,
    properties?: Properties,
    opts?: CaptureOptions,
  ): Promise<CaptureResult>;
  flush(): Promise<void>;
  /**
   * Report an arrival from a tracked link/QR hit to `POST /v1/t/arrive`.
   * Without an argument, reads the `hs_ref` URL param; the param is stripped
   * only AFTER a successful send (a transport failure keeps it so a reload or
   * retry can recapture). The manual escape hatch for SPAs that route before
   * init (`captureRef: false`). Resolves true when the beacon was delivered.
   * Never throws.
   */
  captureRef(ref?: string): Promise<boolean>;
  /**
   * The persisted last-touch attribution (click IDs, `utm_*`, landing page)
   * plus the anon id, flattened for hidden-field passthrough into a
   * third-party form (Heyflow/Perspective/…) so the eventual lead webhook
   * carries identity + click IDs back to the engine. `{ hs_anonymous_id }`
   * alone when nothing has been captured.
   */
  getAttributionFields(): Record<string, string>;

  // ── consumers of the spine ──
  /** v2 — default feedId "in_app". Throws "not implemented in v1". */
  feed(feedId?: string, opts?: FeedFetchOptions): FeedClient;
  preferences(): PreferencesClient;
  /** On-site banners for a slot (default "default"); a `banner:<slot>` feed. */
  banners(slot?: string): BannerClient;
  /** Ephemeral client-side toasts (not persisted; realtime + explicit show()). */
  toasts(): ToastClient;

  // ── lifecycle + reactive store ──
  /**
   * Lazily open the realtime transport for `feedId` (default "in_app") and pipe
   * its item/metadata updates into the feed-store. Idempotent per feedId. POLL
   * is the working default transport (SSE is browser-blocked today).
   */
  connect(feedId?: string): void;
  /** Close sockets, flush queue, remove listeners. */
  teardown(): void;
  /** For `useSyncExternalStore`. */
  subscribe(listener: () => void): () => void;
  getSnapshot(): HogsendState;
  readonly store: Store<HogsendState>;
}
