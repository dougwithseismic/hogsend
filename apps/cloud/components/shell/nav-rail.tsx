"use client";

import { Gauge, Server, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Wordmark } from "@/components/ds/wordmark";
import { cn } from "@/lib/cn";

/**
 * Left navigation rail. Client-only because the active item is derived from
 * the current pathname — everything else in the shell stays a server
 * component. Below md the rail collapses to a horizontal strip above the
 * content (there is no menu state to manage, so no toggle).
 */

export const NAV_ITEMS = [
  { href: "/environments", label: "Environments", icon: Server },
  { href: "/usage", label: "Usage", icon: Gauge },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function NavRail({ orgSwitcher }: { orgSwitcher?: ReactNode }) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className="z-30 flex flex-col gap-6 border-white/[0.08] border-b bg-ink-raised px-4 py-4 md:fixed md:inset-y-0 md:left-0 md:w-rail md:border-r md:border-b-0 md:px-4 md:py-5"
    >
      <Link
        href="/"
        className="px-2 transition-opacity hover:opacity-70 md:px-2"
      >
        <Wordmark />
      </Link>

      {orgSwitcher}

      <ul className="flex flex-row gap-1 overflow-x-auto md:flex-col md:overflow-visible">
        {NAV_ITEMS.map((item) => {
          const active = isActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2.5 whitespace-nowrap rounded-md px-2.5 py-2 text-sm tracking-[-0.02em] transition-colors duration-200",
                  active
                    ? "bg-accent-tint text-white"
                    : "text-white/60 hover:bg-white/[0.04] hover:text-white",
                )}
              >
                <Icon
                  aria-hidden="true"
                  className={cn(
                    "size-4 shrink-0",
                    active ? "text-accent" : "text-white/40",
                  )}
                  strokeWidth={1.75}
                />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
