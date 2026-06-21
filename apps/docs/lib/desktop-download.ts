import {
  DESKTOP_BUILDS,
  DESKTOP_DOWNLOAD_URL_MAC,
  DESKTOP_DOWNLOAD_URL_WIN,
} from "@/lib/site";

type Os = "mac" | "windows" | "other";

/** A resolved download for the visitor's OS, or `null` when we ship no build
 *  for it (per DESKTOP_BUILDS) so callers can render a dead-end-free link. */
export type DesktopDownload = { href: string; label: string };

/**
 * Resolve the desktop download for the current visitor's OS, gated on the
 * builds we actually ship (DESKTOP_BUILDS). Returns the macOS .dmg / Windows
 * .exe target, or `null` for Linux/mobile/unknown or an OS we don't ship yet.
 *
 * Detection reads `navigator`, so this is client-only — call it from an effect
 * and render nothing until it resolves to avoid a hydration mismatch.
 */
export function resolveDesktopDownload(): DesktopDownload | null {
  const os = detectOs();
  if (os === "mac" && DESKTOP_BUILDS.mac) {
    return { href: DESKTOP_DOWNLOAD_URL_MAC, label: "Mac app" };
  }
  if (os === "windows" && DESKTOP_BUILDS.windows) {
    return { href: DESKTOP_DOWNLOAD_URL_WIN, label: "Windows app" };
  }
  return null;
}

function detectOs(): Os {
  if (typeof navigator === "undefined") return "other";
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const platform = nav.userAgentData?.platform || nav.platform || "";
  const ua = nav.userAgent;
  // iPadOS reports as "MacIntel"; exclude touch devices — no desktop app there.
  const isTouch = nav.maxTouchPoints > 1;
  if (!isTouch && (/mac/i.test(platform) || /Macintosh/i.test(ua))) {
    return "mac";
  }
  if (/win/i.test(platform) || /Windows/i.test(ua)) return "windows";
  return "other";
}
