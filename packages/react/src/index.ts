/**
 * `@hogsend/react` — provider + hooks + the v1 NotificationBell shell. A
 * hooks-only import pulls NO component CSS (the stylesheet is opt-in via
 * `import "@hogsend/react/styles.css"`).
 */

// ── re-exported core types ──
export type {
  Banner,
  ColorMode,
  FeedItem,
  FeedMetadata,
  Hogsend,
  HogsendConfig,
  ListSummary,
  PreferencesState,
  Properties,
  Toast,
} from "@hogsend/js";
// ── components ──
export {
  Banner as BannerView,
  type BannerClassNames,
  type BannerPlacement,
  type BannerProps,
  type BannerRenderHelpers,
} from "./components/banner/banner.js";
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
  type SurveyBlock,
  type SurveyBlockClassNames,
  type SurveyBlockProps,
  SurveyBlockView,
} from "./components/feed/survey-block.js";
export {
  FeedPopover,
  type FeedPopoverClassNames,
  type FeedPopoverPlacement,
  type FeedPopoverProps,
  type FeedPopoverTab,
} from "./components/popover/feed-popover.js";
export {
  PreferenceCenter,
  type PreferenceCenterClassNames,
  type PreferenceCenterProps,
  type PreferenceChannel,
} from "./components/preferences/preference-center.js";
export { Slot, type SlotProps } from "./components/primitives/slot.js";
export {
  VisuallyHidden,
  type VisuallyHiddenProps,
} from "./components/primitives/visually-hidden.js";
export {
  Toast as ToastView,
  type ToastClassNames,
  type ToastProps,
} from "./components/toast/toast.js";
export {
  ToastContainer,
  type ToastContainerProps,
  type ToastPlacement,
} from "./components/toast/toast-container.js";
// ── headless ──
export {
  FeedStateProvider,
  type FeedStateProviderProps,
} from "./headless/feed-state.js";
// ── hooks ──
export { type UseBanner, useBanner } from "./hooks/use-banner.js";
export {
  resolveSystemColorMode,
  useColorMode,
  watchSystemColorMode,
} from "./hooks/use-color-mode.js";
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
export { type UseToast, useToast } from "./hooks/use-toast.js";
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
