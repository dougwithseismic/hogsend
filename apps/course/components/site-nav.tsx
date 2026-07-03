"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { type JSX, useEffect, useState } from "react";
import { UserMenu } from "@/components/auth/user-menu";
import { NavBell } from "@/components/hogsend/nav-bell";
import { CourseHogsendProvider } from "@/components/hogsend/provider";
import { Logo } from "@/components/logo";
import { cn } from "@/lib/cn";
import { HOGSEND_URL } from "@/lib/site";

const NAV_LINKS: Array<{ label: string; href: string }> = [
  { label: "Courses", href: "/" },
  { label: "Workbook", href: "/workbook" },
  { label: "Pricing", href: "/pricing" },
];

/**
 * Course site navigation — the simplified sibling of the docs SiteNav. Sticky in
 * normal flow (h-20 / 5rem) so the catalog layout AND the Fumadocs lesson reader
 * share one chrome; the reader offsets its sticky sidebar with a matching
 * --fd-banner-height. No mega-menus / downloads — Courses, Pricing, a link
 * back to hogsend.com, the notification bell (signed-in readers get their
 * identified Hogsend feed), and the session control.
 */
export function SiteNav({ className }: { className?: string }): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  // The Hogsend feed provider wraps ONLY the nav (its bell is the sole feed
  // consumer). Its identity-driven remount (anon → identified) is invisible
  // here — the nav has no entrance animation — instead of blowing away the
  // page's scroll-reveal animations, which it did when it sat at the root.
  return (
    <CourseHogsendProvider>
      <header
        className={cn(
          "sticky top-0 z-50 border-b border-hairline-faint text-white backdrop-blur-[7px]",
          menuOpen ? "bg-ink/95" : "bg-ink/70",
          className,
        )}
      >
        <nav
          aria-label="Primary"
          className="container-page flex h-20 items-center justify-between md:grid md:grid-cols-[1fr_auto_1fr]"
        >
          {/* Left: brand */}
          <div className="flex items-center">
            <Link
              href="/"
              aria-label="Hogsend Courses home"
              className="rounded-[6px] outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <Logo />
            </Link>
          </div>

          {/* Center: desktop links */}
          <ul className="hidden items-center gap-8 md:flex">
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="rounded text-[15px] text-white/90 tracking-[-0.02em] outline-none transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {link.label}
                </Link>
              </li>
            ))}
            <li>
              <a
                href={HOGSEND_URL}
                target="_blank"
                rel="noreferrer"
                className="rounded text-[15px] text-white/90 tracking-[-0.02em] outline-none transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-accent"
              >
                Hogsend ↗
              </a>
            </li>
          </ul>

          {/* Right: notifications + session (desktop) */}
          <div className="hidden items-center justify-end gap-4 md:flex">
            <NavBell align="end" />
            <UserMenu />
          </div>

          {/* Mobile: bell + hamburger */}
          <div className="flex items-center gap-1 md:hidden">
            <NavBell align="end" />
            <button
              type="button"
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              aria-expanded={menuOpen}
              aria-controls="course-nav-mobile"
              onClick={() => setMenuOpen((open) => !open)}
              className="flex size-10 items-center justify-center rounded-[6px] text-white outline-none transition-colors hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-accent"
            >
              {menuOpen ? (
                <X className="size-5" strokeWidth={1.5} />
              ) : (
                <Menu className="size-5" strokeWidth={1.5} />
              )}
            </button>
          </div>
        </nav>

        {/* Mobile panel */}
        <div
          id="course-nav-mobile"
          hidden={!menuOpen}
          className="border-t border-hairline-faint bg-ink/95 backdrop-blur-md md:hidden"
        >
          <div className="container-page flex flex-col gap-1 py-4">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMenuOpen(false)}
                className="rounded-[6px] px-1 py-2.5 text-base text-white/80 outline-none transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-accent"
              >
                {link.label}
              </Link>
            ))}
            <a
              href={HOGSEND_URL}
              target="_blank"
              rel="noreferrer"
              className="rounded-[6px] px-1 py-2.5 text-base text-white/80 outline-none transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-accent"
            >
              Hogsend ↗
            </a>
            <div className="my-2 h-px bg-hairline-faint" />
            <div className="px-1 py-1">
              <UserMenu />
            </div>
          </div>
        </div>
      </header>
    </CourseHogsendProvider>
  );
}
