"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { type JSX, useEffect, useState } from "react";
import { UserMenu } from "@/components/auth/user-menu";
import { NavBell } from "@/components/hogsend/nav-bell";
import { CourseHogsendProvider } from "@/components/hogsend/provider";
import { Logo } from "@/components/logo";
import { cn } from "@/lib/cn";
import { DISCORD_INVITE_URL, HOGSEND_URL } from "@/lib/site";

const NAV_LINKS: Array<{ label: string; href: string }> = [
  { label: "Courses", href: "/" },
  { label: "Workbook", href: "/workbook" },
  { label: "Pricing", href: "/pricing" },
];

/** Discord mark (inline, matches the docs SiteNav's treatment). */
function DiscordMark({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.369a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03ZM8.02 15.331c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418Zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418Z" />
    </svg>
  );
}

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

          {/* Right: Discord + notifications + session (desktop) */}
          <div className="hidden items-center justify-end gap-4 md:flex">
            <a
              href={DISCORD_INVITE_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="Join the Hogsend Discord"
              className="flex size-9 items-center justify-center rounded-[6px] text-white/70 outline-none transition-colors hover:bg-white/5 hover:text-white focus-visible:ring-2 focus-visible:ring-accent"
            >
              <DiscordMark className="size-5" />
            </a>
            <NavBell align="end" />
            <UserMenu />
          </div>

          {/* Mobile: Discord + bell + hamburger */}
          <div className="flex items-center gap-1 md:hidden">
            <a
              href={DISCORD_INVITE_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="Join the Hogsend Discord"
              className="flex size-10 items-center justify-center rounded-[6px] text-white/70 outline-none transition-colors hover:bg-white/5 hover:text-white focus-visible:ring-2 focus-visible:ring-accent"
            >
              <DiscordMark className="size-5" />
            </a>
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
