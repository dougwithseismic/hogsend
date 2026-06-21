"use client";

import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import {
  type DesktopDownload,
  resolveDesktopDownload,
} from "@/lib/desktop-download";

/**
 * Download link for the desktop app, shown in the nav's icon row. Resolves to
 * the visitor's OS build (macOS .dmg / Windows .exe) and renders nothing when
 * we don't ship that OS yet (per DESKTOP_BUILDS) — so visitors never get a
 * dead-end link. Linux/mobile/unknown fall through to nothing.
 */
export function DownloadNavLink() {
  // Detection is client-only; render nothing until mounted so SSR and the
  // unsupported case both produce no link (and no hydration mismatch).
  const [target, setTarget] = useState<DesktopDownload | null>(null);

  useEffect(() => {
    setTarget(resolveDesktopDownload());
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
