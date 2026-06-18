"use client";

import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import {
  DESKTOP_BUILDS,
  DESKTOP_DOWNLOAD_URL_MAC,
  DESKTOP_DOWNLOAD_URL_WIN,
} from "@/lib/site";

type Os = "mac" | "windows" | "other";

/**
 * Download link for the desktop app, shown in the nav's icon row. Resolves to
 * the visitor's OS build (macOS .dmg / Windows .exe) and renders nothing when
 * we don't ship that OS yet (per DESKTOP_BUILDS) — so visitors never get a
 * dead-end link. Linux/mobile/unknown fall through to nothing.
 */
export function DownloadNavLink() {
  // Detection is client-only; render nothing until mounted so SSR and the
  // unsupported case both produce no link (and no hydration mismatch).
  const [target, setTarget] = useState<{ href: string; label: string } | null>(
    null,
  );

  useEffect(() => {
    const os = detectOs();
    if (os === "mac" && DESKTOP_BUILDS.mac) {
      setTarget({ href: DESKTOP_DOWNLOAD_URL_MAC, label: "Mac app" });
    } else if (os === "windows" && DESKTOP_BUILDS.windows) {
      setTarget({ href: DESKTOP_DOWNLOAD_URL_WIN, label: "Windows app" });
    }
  }, []);

  if (!target) return null;

  return (
    <a
      href={target.href}
      target="_blank"
      rel="noreferrer"
      aria-label={`Download the Hogsend ${target.label}`}
      title={`Download the Hogsend ${target.label}`}
      className="inline-flex size-9 items-center justify-center rounded-md text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
    >
      <Download className="size-5" />
    </a>
  );
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
