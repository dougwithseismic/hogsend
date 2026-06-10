"use client";

import { usePathname } from "next/navigation";
import { type JSX, useEffect, useRef } from "react";
import { AnalyticsEvent, capture } from "@/lib/analytics";

/**
 * Classify a pathname into the low-cardinality shape PostHog insights and
 * Hogsend bucket criteria filter on:
 *
 *   /docs/cli/studio        → { area: "docs", section: "cli", slug: "cli/studio" }
 *   /docs/about             → { area: "docs", section: "root", slug: "about" }
 *   /docs                   → { area: "docs", section: "root", slug: "index" }
 *   /use-cases/onboarding   → { area: "marketing", section: "use-cases", slug: "onboarding" }
 *   /about                  → { area: "marketing", section: "about", slug: "about" }
 *   /                       → { area: "marketing", section: "home", slug: "home" }
 */
export function classifyPath(pathname: string): {
  area: "docs" | "marketing";
  section: string;
  slug: string;
} {
  const segments = pathname.split("/").filter(Boolean);

  if (segments[0] === "docs") {
    const rest = segments.slice(1);
    return {
      area: "docs",
      section: rest.length >= 2 ? rest[0] : "root",
      slug: rest.join("/") || "index",
    };
  }

  return {
    area: "marketing",
    section: segments[0] ?? "home",
    slug: segments.slice(1).join("/") || (segments[0] ?? "home"),
  };
}

/**
 * PageViewTracker — fires one semantic `page_viewed` event per route view,
 * mounted once in the root layout. PostHog's auto `$pageview` stays on for
 * raw counts; this event adds the `{ area, section, slug }` classification
 * that makes "read 3+ api-reference pages" a one-filter insight (and, once
 * forwarded, a Hogsend bucket criterion).
 */
export function PageViewTracker(): JSX.Element | null {
  const pathname = usePathname();
  const lastTracked = useRef<string | null>(null);

  useEffect(() => {
    if (!pathname || lastTracked.current === pathname) return;
    lastTracked.current = pathname;

    const { area, section, slug } = classifyPath(pathname);
    capture(AnalyticsEvent.PAGE_VIEWED, {
      area,
      section,
      slug,
      path: pathname,
    });
  }, [pathname]);

  return null;
}
