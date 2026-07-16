"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { UserMenu } from "@/components/auth/user-menu";
import { NavBell } from "@/components/hogsend/nav-bell";
import {
  NavDropdown,
  PLAYBOOK_LINKS,
  RECIPE_LINKS,
  USE_CASE_LINKS,
} from "@/components/landing/site-nav";
import { cn } from "@/lib/cn";
import { DISCORD_INVITE_URL, GITHUB_URL } from "@/lib/site";
import { DiscordMark, GitHubMark, InkLogo } from "./brand";

/* The landing nav — the spike-polar 54px bar, now carrying the same surfaced
 * navigation as the interior SiteNav: the Use-cases, Recipes and Playbook mega panels
 * (shared data + panel component, restyled trigger) plus the flat links and a
 * mobile panel (the old PsNav had NO links at all below md).
 *
 * This is the site-wide marketing nav. The homepage renders it `sticky top-0`
 * (in flow, below its own hero); the interior marketing layout renders it
 * `fixed` below the announcement banner (`fixed` prop) so the existing pages'
 * top clearance (pt-32) keeps working with no per-page changes. */

const FLAT_LINKS = [
  { label: "Templates", href: "/emails" },
  { label: "Pricing", href: "/pricing" },
  { label: "Docs", href: "/docs" },
  { label: "Articles", href: "/articles" },
  { label: "Changelog", href: "/changelog" },
];

const TRIGGER_CLASS =
  "font-medium text-white text-sm tracking-[-0.025em] transition-opacity hover:opacity-70";

export function PsNav({ fixed = false }: { fixed?: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false);

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
        "z-50 border-[#f6483833] border-b bg-[#050101]/85 backdrop-blur",
        // Homepage: sticky in flow. Interior marketing pages: fixed below the
        // announcement banner (its height drives --fd-banner-height).
        fixed
          ? "fixed inset-x-0 top-[var(--fd-banner-height,0px)]"
          : "sticky top-0",
      )}
    >
      <div className="mx-auto flex h-[54px] w-full max-w-[1256px] items-center justify-between px-6 md:px-10">
        <div className="flex items-center gap-8">
          <Link href="/">
            <InkLogo />
          </Link>
          <ul className="hidden items-center gap-5 md:flex">
            <NavDropdown
              label="Use cases"
              triggerHref="/#use-cases"
              items={USE_CASE_LINKS}
              footer={{
                label: "Browse the 13 templates they send →",
                href: "/emails",
              }}
              triggerClassName={TRIGGER_CLASS}
            />
            <NavDropdown
              label="Recipes"
              triggerHref="/recipes"
              items={RECIPE_LINKS}
              footer={{ label: "Browse all 35 recipes →", href: "/recipes" }}
              triggerClassName={TRIGGER_CLASS}
            />
            <NavDropdown
              label="Playbook"
              triggerHref="/playbook"
              items={PLAYBOOK_LINKS}
              footer={{ label: "Browse all 19 plays →", href: "/playbook" }}
              triggerClassName={TRIGGER_CLASS}
            />
            {FLAT_LINKS.map((l) => (
              <li key={l.label}>
                <Link href={l.href} className={TRIGGER_CLASS}>
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex items-center gap-2">
          {/* The REAL nav bell — the live in-app feed entry point. Renders
              nothing when no engine is wired (isHogsendConfigured gate). */}
          <NavBell align="end" variant="bordered" />
          <a
            href={GITHUB_URL}
            aria-label="GitHub"
            className="hidden size-8 items-center justify-center rounded-[6px] border border-white/10 text-white/75 transition-colors hover:border-white/30 hover:text-white sm:inline-flex"
          >
            <GitHubMark className="size-4" />
          </a>
          <a
            href={DISCORD_INVITE_URL}
            aria-label="Discord"
            className="hidden size-8 items-center justify-center rounded-[6px] border border-white/10 text-white/75 transition-colors hover:border-white/30 hover:text-white sm:inline-flex"
          >
            <DiscordMark className="size-4" />
          </a>
          <Link
            href="/docs/getting-started"
            className="ml-1 hidden h-8 items-center rounded-[6px] bg-white px-3.5 font-medium text-[#0a0606] text-sm tracking-[-0.02em] transition-opacity hover:opacity-85 md:inline-flex"
          >
            Start building
          </Link>
          {/* Session state: "Sign in" when logged out, avatar → Portal when in. */}
          <div className="ml-1">
            <UserMenu />
          </div>
          <button
            type="button"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            aria-controls="landing-nav-mobile"
            onClick={() => setMenuOpen((open) => !open)}
            className="flex size-8 items-center justify-center rounded-[6px] border border-white/10 text-white md:hidden"
          >
            {menuOpen ? (
              <X className="size-4" strokeWidth={1.5} />
            ) : (
              <Menu className="size-4" strokeWidth={1.5} />
            )}
          </button>
        </div>
      </div>

      {/* Mobile panel — grouped like the interior SiteNav's. */}
      <div
        id="landing-nav-mobile"
        hidden={!menuOpen}
        className="max-h-[calc(100vh-54px)] overflow-y-auto border-white/10 border-t bg-[#050101]/95 backdrop-blur-md md:hidden"
      >
        <div className="mx-auto flex w-full max-w-[1256px] flex-col gap-1 px-6 py-4">
          {FLAT_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={() => setMenuOpen(false)}
              className="rounded-[6px] px-1 py-2.5 text-base text-white/80 transition-colors hover:text-white"
            >
              {l.label}
            </Link>
          ))}
          <div className="my-2 h-px bg-white/10" />
          <span className="px-1 pt-1 pb-1.5 font-mono text-[11px] text-white/40 uppercase tracking-[0.08em]">
            Use cases
          </span>
          {USE_CASE_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={() => setMenuOpen(false)}
              className="rounded-[6px] px-1 py-2.5 text-base text-white/80 transition-colors hover:text-white"
            >
              {l.label}
            </Link>
          ))}
          <div className="my-2 h-px bg-white/10" />
          <span className="px-1 pt-1 pb-1.5 font-mono text-[11px] text-white/40 uppercase tracking-[0.08em]">
            Recipes
          </span>
          {RECIPE_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={() => setMenuOpen(false)}
              className="rounded-[6px] px-1 py-2.5 text-base text-white/80 transition-colors hover:text-white"
            >
              {l.label}
            </Link>
          ))}
          <Link
            href="/recipes"
            onClick={() => setMenuOpen(false)}
            className="rounded-[6px] px-1 py-2.5 text-base text-white/60 transition-colors hover:text-white"
          >
            Browse all 35 recipes →
          </Link>
          <div className="my-2 h-px bg-white/10" />
          <span className="px-1 pt-1 pb-1.5 font-mono text-[11px] text-white/40 uppercase tracking-[0.08em]">
            Playbook
          </span>
          {PLAYBOOK_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={() => setMenuOpen(false)}
              className="rounded-[6px] px-1 py-2.5 text-base text-white/80 transition-colors hover:text-white"
            >
              {l.label}
            </Link>
          ))}
          <Link
            href="/playbook"
            onClick={() => setMenuOpen(false)}
            className="rounded-[6px] px-1 py-2.5 text-base text-white/60 transition-colors hover:text-white"
          >
            Browse all 19 plays →
          </Link>
          <Link
            href="/portal"
            onClick={() => setMenuOpen(false)}
            className="rounded-[6px] px-1 py-2.5 text-base text-white/60 transition-colors hover:text-white"
          >
            Customer portal
          </Link>
          <div className="my-2 h-px bg-white/10" />
          {/* Community — hidden as icon buttons below sm, surfaced here. */}
          <div className="flex items-center gap-2">
            <a
              href={GITHUB_URL}
              onClick={() => setMenuOpen(false)}
              className="inline-flex flex-1 items-center gap-2.5 rounded-[6px] border border-white/10 px-3 py-2.5 text-base text-white/80 transition-colors hover:border-white/30 hover:text-white"
            >
              <GitHubMark className="size-4" />
              GitHub
            </a>
            <a
              href={DISCORD_INVITE_URL}
              onClick={() => setMenuOpen(false)}
              className="inline-flex flex-1 items-center gap-2.5 rounded-[6px] border border-white/10 px-3 py-2.5 text-base text-white/80 transition-colors hover:border-white/30 hover:text-white"
            >
              <DiscordMark className="size-4" />
              Discord
            </a>
          </div>
          <Link
            href="/docs/getting-started"
            onClick={() => setMenuOpen(false)}
            className={cn(
              "mt-3 inline-flex h-10 items-center justify-center rounded-[6px] bg-white px-4",
              "font-medium text-[#0a0606] text-sm tracking-[-0.02em]",
            )}
          >
            Start building
          </Link>
        </div>
      </div>
    </header>
  );
}
