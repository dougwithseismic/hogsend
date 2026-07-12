/**
 * The allowlisted ad-platform click-ID query params. Canonical server-side
 * copy — `@hogsend/js` re-declares the same list (`CLICK_ID_PARAMS`) because
 * it is zero-dependency and cannot import core. Keep the two in sync BY HAND;
 * an api test pins it.
 */
export const CLICK_ID_PARAM_NAMES = [
  "fbclid", // Meta
  "gclid", // Google
  "gbraid", // Google (iOS, app-to-web)
  "wbraid", // Google (iOS, web-to-app)
  "ttclid", // TikTok
  "msclkid", // Microsoft
  "li_fat_id", // LinkedIn
  "twclid", // X/Twitter
  "rdt_cid", // Reddit
  "epik", // Pinterest
  "sccid", // Snap
] as const;

export type ClickIdParamName = (typeof CLICK_ID_PARAM_NAMES)[number];
