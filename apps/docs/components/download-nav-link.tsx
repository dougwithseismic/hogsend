"use client";

import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { DESKTOP_DOWNLOAD_URL } from "@/lib/site";

/**
 * Download link for the macOS desktop app, shown in the nav's icon row.
 *
 * Only renders on macOS — the only build today is a Mac .dmg, so offering
 * "Download" to Windows/Linux/mobile visitors would be a dead end. When other
 * platforms ship, branch the href/label by `detectOs()` here rather than
 * hiding it.
 */
export function DownloadNavLink() {
  const [isMac, setIsMac] = useState(false);

  // Platform detection is client-only; render nothing until we've checked, so
  // SSR and the non-Mac case both produce no link (and no hydration mismatch).
  useEffect(() => {
    setIsMac(isMacOs());
  }, []);

  if (!isMac) return null;

  return (
    <a
      href={DESKTOP_DOWNLOAD_URL}
      target="_blank"
      rel="noreferrer"
      aria-label="Download the Hogsend Mac app"
      title="Download the Hogsend Mac app"
      className="inline-flex size-9 items-center justify-center rounded-md text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
    >
      <Download className="size-5" />
    </a>
  );
}

function isMacOs(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const platform = nav.userAgentData?.platform || nav.platform || "";
  const isMacPlatform =
    /mac/i.test(platform) || /Macintosh/i.test(nav.userAgent);
  // iPadOS reports as "MacIntel"; exclude touch devices — no .app there.
  const isTouch = nav.maxTouchPoints > 1;
  return isMacPlatform && !isTouch;
}
