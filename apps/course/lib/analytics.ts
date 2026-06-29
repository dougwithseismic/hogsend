/**
 * Phase 1 stub. The copied DS components (copy-button, tabs, faq) fire
 * interaction analytics through this module; in the course app it's a no-op for
 * now. Phase 4 wires real capture (course.* events → the dogfood engine), at
 * which point this gains a real implementation without touching the components.
 */

export const AnalyticsEvent = {
  FAQ_OPENED: "faq_opened",
  CODE_COPIED: "code_copied",
  TAB_SELECTED: "tab_selected",
} as const;

export type AnalyticsEventName =
  (typeof AnalyticsEvent)[keyof typeof AnalyticsEvent];

export function capture(
  _event: AnalyticsEventName,
  _props?: Record<string, unknown>,
): void {
  // no-op in Phase 1
}
