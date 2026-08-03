"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { BARE_ROUTES } from "@/src/lib/auth-guard";
import { NavRail } from "./nav-rail";

/**
 * Decides whether a page gets the dashboard chrome. The auth screens are
 * standalone — a nav rail pointing at pages the visitor cannot open yet is
 * noise, and the middleware would redirect every one of those links anyway.
 *
 * Client-only for the same reason NavRail is: the decision is a pathname read.
 * The layout above it stays a server component — which is why `orgSwitcher`
 * arrives as a prop: it is an async server component, rendered above this one.
 */
export function AppChrome({
  children,
  orgSwitcher,
}: {
  children: ReactNode;
  orgSwitcher?: ReactNode;
}) {
  const pathname = usePathname();
  const bare = BARE_ROUTES.some((route) => pathname.startsWith(route));

  if (bare) {
    return (
      <div className="relative z-10 flex min-h-dvh flex-col">{children}</div>
    );
  }

  return (
    <>
      <NavRail orgSwitcher={orgSwitcher} />
      {/* The rail is fixed at md+, so the content column carries its width
          as a left offset. Below md the rail sits in flow above it. */}
      <div className="relative z-10 flex min-h-dvh flex-col md:pl-rail">
        {children}
      </div>
    </>
  );
}
