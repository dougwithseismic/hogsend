"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AUTH_ROUTES } from "@/src/lib/auth-guard";
import { NavRail } from "./nav-rail";

/**
 * Decides whether a page gets the dashboard chrome. The auth screens are
 * standalone — a nav rail pointing at pages the visitor cannot open yet is
 * noise, and the middleware would redirect every one of those links anyway.
 *
 * Client-only for the same reason NavRail is: the decision is a pathname read.
 * The layout above it stays a server component.
 */
export function AppChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const bare = AUTH_ROUTES.some((route) => pathname.startsWith(route));

  if (bare) {
    return (
      <div className="relative z-10 flex min-h-dvh flex-col">{children}</div>
    );
  }

  return (
    <>
      <NavRail />
      {/* The rail is fixed at md+, so the content column carries its width
          as a left offset. Below md the rail sits in flow above it. */}
      <div className="relative z-10 flex min-h-dvh flex-col md:pl-rail">
        {children}
      </div>
    </>
  );
}
