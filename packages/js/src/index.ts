/**
 * `@hogsend/js` — zero-dependency browser core SDK. Barrel: the
 * `createHogsend` factory, error classes, the store, and type-only re-exports.
 * Subpath entries (`./preferences`, `./feed`, `./banner`, `./realtime`) keep
 * surface-specific code out of the core import.
 */

export type { Banner, BannerClient } from "./banner/index.js";
export { createHogsend } from "./client.js";
export { HogsendAPIError, RateLimitError } from "./errors.js";
export type {
  FeedBlock,
  FeedClient,
  FeedFetchOptions,
  FeedItem,
  FeedItemStatus,
  FeedMetadata,
  FeedPageInfo,
  MarkState,
} from "./feed/index.js";
export type { RealtimeChannel, RealtimeTransport } from "./realtime/index.js";
export type { Patch, Store } from "./store/external-store.js";
export { createStore } from "./store/external-store.js";
export type {
  BannerSliceState,
  CaptureOptions,
  CaptureResult,
  ColorMode,
  FeedSliceState,
  Hogsend,
  HogsendConfig,
  HogsendState,
  IdentitySlice,
  ListSummary,
  PreferencesClient,
  PreferencesState,
  Properties,
  RealtimeMode,
  StorageAdapter,
} from "./types.js";
