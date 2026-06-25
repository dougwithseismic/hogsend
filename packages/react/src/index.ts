/**
 * `@hogsend/react` — provider + hooks + the v1 NotificationBell shell. A
 * hooks-only import pulls NO component CSS (the stylesheet is opt-in via
 * `import "@hogsend/react/styles.css"`).
 */

// ── re-exported core types ──
export type {
  ColorMode,
  FeedItem,
  FeedMetadata,
  Hogsend,
  HogsendConfig,
  ListSummary,
  PreferencesState,
  Properties,
} from "@hogsend/js";
// ── components ──
export {
  type BadgeCountType,
  NotificationBell,
  type NotificationBellClassNames,
  type NotificationBellProps,
} from "./components/bell/notification-bell.js";
export {
  FeedItem as FeedItemView,
  type FeedItemClassNames,
  type FeedItemProps,
} from "./components/feed/feed-item.js";
export {
  type FeedFilterStatus,
  type FeedHeaderRenderState,
  NotificationFeed,
  type NotificationFeedClassNames,
  type NotificationFeedProps,
} from "./components/feed/notification-feed.js";
export {
  FeedPopover,
  type FeedPopoverClassNames,
  type FeedPopoverPlacement,
  type FeedPopoverProps,
} from "./components/popover/feed-popover.js";
export { Slot, type SlotProps } from "./components/primitives/slot.js";
export {
  VisuallyHidden,
  type VisuallyHiddenProps,
} from "./components/primitives/visually-hidden.js";
// ── headless ──
export {
  FeedStateProvider,
  type FeedStateProviderProps,
} from "./headless/feed-state.js";
export {
  resolveSystemColorMode,
  useColorMode,
  watchSystemColorMode,
} from "./hooks/use-color-mode.js";
// ── hooks ──
export { type UseHogsend, useHogsend } from "./hooks/use-hogsend.js";
export {
  type FeedNetworkStatus,
  type UseHogsendFeed,
  type UseHogsendFeedOptions,
  useHogsendFeed,
  useInbox,
} from "./hooks/use-hogsend-feed.js";
export {
  type UsePreferences,
  usePreferences,
} from "./hooks/use-preferences.js";
export { useStoreSelector } from "./hooks/use-store.js";
// ── styling utilities ──
export { type ClassValue, cn } from "./lib/cn.js";
export {
  type DataAttributes,
  dataVariants,
  type VariantProps,
} from "./lib/variants.js";
export {
  type ColorModeControls,
  HogsendContext,
  type HogsendContextValue,
} from "./provider/context.js";
export {
  HogsendFeedContext,
  type HogsendFeedContextValue,
} from "./provider/feed-context.js";
export {
  HogsendFeedProvider,
  type HogsendFeedProviderProps,
} from "./provider/feed-provider.js";
// ── provider ──
export {
  HogsendProvider,
  type HogsendProviderProps,
} from "./provider/hogsend-provider.js";
