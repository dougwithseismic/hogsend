"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * The one-page workbook shipped share links like /workbook#wb-ch-… — those
 * anchors now live on per-chapter pages. The overview mounts this with a
 * server-built anchor → href map and forwards any recognised hash; unknown
 * hashes (e.g. #wb-<course>, still a real section id) are left alone.
 */
export function LegacyWorkbookHash({ map }: { map: Record<string, string> }) {
  const router = useRouter();
  useEffect(() => {
    const anchor = window.location.hash.slice(1);
    if (!anchor) return;
    const href = map[anchor];
    if (href) router.replace(href);
  }, [map, router]);
  return null;
}
