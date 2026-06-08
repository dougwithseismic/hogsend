"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { type JSX, useEffect, useState } from "react";
import { Button } from "@/components/ds/button";
import { cn } from "@/lib/cn";
import { Logo } from "./logo";

const GITHUB_URL = "https://github.com/dougwithseismic/hogsend";

const NAV_LINKS: Array<{ label: string; href: string }> = [
  { label: "Docs", href: "/docs" },
  { label: "Integrations", href: "/integrations" },
  { label: "Recipes", href: "/recipes" },
  { label: "Compare", href: "/docs/compare" },
];

/** GitHub mark (inline so we don't pull an icon dep for the wordmark). */
function GitHubMark({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.009-.868-.014-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.31.678.921.678 1.856 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.523 2 12 2Z"
      />
    </svg>
  );
}

/**
 * Sticky homepage navigation. Transparent while over the hero, then fades to a
 * blurred ink bar with a hairline border once the page scrolls past 8px.
 */
export function SiteNav({ className }: { className?: string }): JSX.Element {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Close the mobile panel on Escape for keyboard accessibility.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 text-white transition-[background-color,border-color,backdrop-filter] duration-300",
        scrolled || menuOpen
          ? "border-b border-white/10 bg-ink/80 backdrop-blur-md"
          : "border-b border-transparent bg-transparent",
        className,
      )}
    >
      <nav
        aria-label="Primary"
        className="container-page flex h-[68px] items-center justify-between"
      >
        {/* Left: brand */}
        <Link
          href="/"
          className="rounded-[6px] outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-label="Hogsend home"
        >
          <Logo />
        </Link>

        {/* Center/right: desktop links */}
        <div className="hidden items-center gap-8 md:flex">
          <ul className="flex items-center gap-7">
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="rounded text-sm text-white/70 outline-none transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>

          <div className="flex items-center gap-3">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="Hogsend on GitHub"
              className="flex size-9 items-center justify-center rounded-[6px] text-white/70 outline-none transition-colors hover:bg-white/5 hover:text-white focus-visible:ring-2 focus-visible:ring-accent"
            >
              <GitHubMark className="size-5" />
            </a>
            <Button href="/docs" variant="accent">
              Get started
            </Button>
          </div>
        </div>

        {/* Mobile: GitHub + hamburger */}
        <div className="flex items-center gap-1 md:hidden">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="Hogsend on GitHub"
            className="flex size-10 items-center justify-center rounded-[6px] text-white/70 outline-none transition-colors hover:bg-white/5 hover:text-white focus-visible:ring-2 focus-visible:ring-accent"
          >
            <GitHubMark className="size-5" />
          </a>
          <button
            type="button"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            aria-controls="site-nav-mobile"
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
        id="site-nav-mobile"
        hidden={!menuOpen}
        className={cn(
          "border-t border-white/10 bg-ink/95 backdrop-blur-md md:hidden",
        )}
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
          <div className="mt-3">
            <Button
              href="/docs"
              variant="accent"
              className="w-full justify-center"
            >
              Get started
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}
