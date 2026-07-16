"use client";

import { ChevronDown, Download, Menu, X } from "lucide-react";
import Link from "next/link";
import { type JSX, useEffect, useState } from "react";
import { Button } from "@/components/ds/button";
import { NavBell } from "@/components/hogsend/nav-bell";
import { cn } from "@/lib/cn";
import {
  type DesktopDownload,
  resolveDesktopDownload,
} from "@/lib/desktop-download";
import { DISCORD_INVITE_URL, GITHUB_URL } from "@/lib/site";
import { Logo } from "./logo";

const NAV_LINKS: Array<{ label: string; href: string }> = [
  { label: "Components", href: "/components" },
  { label: "Templates", href: "/emails" },
  { label: "Playbook", href: "/playbook" },
  { label: "Pricing", href: "/pricing" },
  { label: "Docs", href: "/docs" },
];

export type MenuItem = { label: string; description: string; href: string };
export type MenuFooter = { label: string; href: string };

/** Items in the "Use cases" dropdown (and the mobile panel's second group). */
export const USE_CASE_LINKS: MenuItem[] = [
  {
    label: "Onboarding",
    description: "Welcome flows that branch on what new users actually do.",
    href: "/use-cases/onboarding",
  },
  {
    label: "Trial conversion",
    description: "Usage-driven nudges that stop the moment they pay.",
    href: "/use-cases/trial-conversion",
  },
  {
    label: "Win-back",
    description: "Spot who's gone quiet and bring them back.",
    href: "/use-cases/winback",
  },
  {
    label: "Community",
    description: "Read Discord activity off the same contact as your product.",
    href: "/use-cases/community",
  },
  {
    label: "Failed payments",
    description: "Reminders that sound human and stop when payment clears.",
    href: "/recipes/category/conversion#failed-payment-dunning",
  },
  {
    label: "Paid acquisition",
    description: "Send Meta the sale, not the click — values, real click IDs.",
    href: "/paid",
  },
  {
    label: "Campaigns",
    description: "One-off broadcasts to a list — scheduled, cancelable.",
    href: "/campaigns",
  },
  {
    label: "Fire and forget",
    description: "Built for agents — domain to first send in half an hour.",
    href: "/fire-and-forget",
  },
];

/** Items in the "Recipes" dropdown — the eight catalog categories. */
export const RECIPE_LINKS: MenuItem[] = [
  {
    label: "Onboarding",
    description: "Welcome series, activation milestones, waitlists.",
    href: "/recipes/category/onboarding",
  },
  {
    label: "Trial & billing",
    description: "Trial arcs, dunning, and upgrade nudges.",
    href: "/recipes/category/conversion",
  },
  {
    label: "E-commerce",
    description: "Carts, orders, deliveries, and restocks.",
    href: "/recipes/category/ecommerce",
  },
  {
    label: "Retention",
    description: "Win-backs, NPS, digests, anniversaries.",
    href: "/recipes/category/retention",
  },
  {
    label: "Scheduling",
    description: "Land sends at the right local time.",
    href: "/recipes/category/scheduling",
  },
  {
    label: "Human-in-the-loop",
    description: "Approvals, lead alerts, concierge touches.",
    href: "/recipes/category/human-in-the-loop",
  },
  {
    label: "Agents & AI",
    description: "Agents on the same event stream your app uses.",
    href: "/recipes/category/agentic",
  },
  {
    label: "Pipelines",
    description: "Webhook sources in, destinations out.",
    href: "/recipes/category/pipelines",
  },
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

/** Discord mark (inline, matches the GitHub mark's treatment). */
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
 * OS-aware desktop download icon link, sized to sit beside the GitHub mark in
 * either the desktop (`size-9`) or mobile (`size-10`) icon row. Resolves to the
 * visitor's build (macOS .dmg / Windows .exe) client-side and renders nothing
 * for an OS we don't ship yet, or until mounted — so SSR and the unsupported
 * case both produce no link (and no hydration mismatch).
 */
function DownloadNavLink({
  size,
}: {
  size: "size-9" | "size-10";
}): JSX.Element | null {
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
      className={cn(
        "flex items-center justify-center rounded-[6px] text-white/70 outline-none transition-colors hover:bg-white/5 hover:text-white focus-visible:ring-2 focus-visible:ring-accent",
        size,
      )}
    >
      <Download className="size-5" strokeWidth={1.5} />
    </a>
  );
}

/**
 * A center-nav item that opens a hover/focus mega panel. The trigger itself
 * still navigates (to the section or index), so it works without a pointer.
 * `triggerClassName` lets a host nav (the landing PsNav) restyle the trigger
 * to its own link idiom without forking the panel.
 */
export function NavDropdown({
  label,
  triggerHref,
  items,
  footer,
  triggerClassName,
}: {
  label: string;
  triggerHref: string;
  items: MenuItem[];
  footer: MenuFooter;
  triggerClassName?: string;
}): JSX.Element {
  return (
    <li className="group relative">
      <Link
        href={triggerHref}
        className={cn(
          "flex items-center gap-1 rounded outline-none focus-visible:ring-2 focus-visible:ring-accent",
          triggerClassName ??
            "text-[15px] tracking-[-0.02em] text-white/90 transition-colors hover:text-white",
        )}
      >
        {label}
        <ChevronDown
          className="size-3.5 text-white/50 transition-transform duration-200 group-hover:rotate-180"
          strokeWidth={1.5}
          aria-hidden="true"
        />
      </Link>

      <div className="invisible absolute top-full left-1/2 -translate-x-1/2 pt-4 opacity-0 transition-[opacity,visibility] duration-150 group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
        <div className="w-[540px] rounded-lg border border-white/10 bg-ink/95 p-2 shadow-black/50 shadow-xl backdrop-blur-md">
          <div className="grid grid-cols-2 gap-1">
            {items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="flex flex-col gap-1 rounded-md p-3 outline-none transition-colors hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-accent"
              >
                <span className="text-[15px] text-white tracking-[-0.02em]">
                  {item.label}
                </span>
                <span className="text-sm text-white/55 leading-5">
                  {item.description}
                </span>
              </Link>
            ))}
          </div>
          <div className="mt-1 border-t border-white/[0.08] px-3 pt-2.5 pb-1.5">
            <Link
              href={footer.href}
              className="rounded text-sm text-white/70 outline-none transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-accent"
            >
              {footer.label}
            </Link>
          </div>
        </div>
      </div>
    </li>
  );
}

/**
 * Fixed site navigation — crimzon chrome: 80px tall, transparent over the
 * page with a constant backdrop blur, full-width bottom hairline. The frame's
 * vertical hairlines pass straight through it.
 */
export function SiteNav({ className }: { className?: string }): JSX.Element {
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
        // top offset = the announcement banner's height (0 once dismissed).
        "fixed inset-x-0 top-[var(--fd-banner-height,0px)] z-50 border-b border-hairline-faint text-white backdrop-blur-[7px]",
        menuOpen ? "bg-ink/95" : "bg-ink/30",
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
            className="rounded-[6px] outline-none focus-visible:ring-2 focus-visible:ring-accent"
            aria-label="Hogsend home"
          >
            <Logo />
          </Link>
        </div>

        {/* Center: desktop links */}
        <ul className="hidden items-center gap-8 md:flex">
          <NavDropdown
            label="Use cases"
            triggerHref="/#use-cases"
            items={USE_CASE_LINKS}
            footer={{
              label: "Browse the 13 templates they send →",
              href: "/emails",
            }}
          />
          <NavDropdown
            label="Recipes"
            triggerHref="/recipes"
            items={RECIPE_LINKS}
            footer={{ label: "Browse all 35 recipes →", href: "/recipes" }}
          />

          {NAV_LINKS.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                className="rounded text-[15px] tracking-[-0.02em] text-white/90 outline-none transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-accent"
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>

        {/* Right: Discord + GitHub + CTA */}
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
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="Hogsend on GitHub"
            className="flex size-9 items-center justify-center rounded-[6px] text-white/70 outline-none transition-colors hover:bg-white/5 hover:text-white focus-visible:ring-2 focus-visible:ring-accent"
          >
            <GitHubMark className="size-5" />
          </a>
          <DownloadNavLink size="size-9" />
          <NavBell align="end" variant="plain" />
          <Button href="/docs/getting-started" variant="outline" icon>
            Start building
          </Button>
        </div>

        {/* Mobile: Discord + GitHub + hamburger */}
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
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="Hogsend on GitHub"
            className="flex size-10 items-center justify-center rounded-[6px] text-white/70 outline-none transition-colors hover:bg-white/5 hover:text-white focus-visible:ring-2 focus-visible:ring-accent"
          >
            <GitHubMark className="size-5" />
          </a>
          <DownloadNavLink size="size-10" />
          <NavBell align="end" variant="plain" />
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
          <div className="my-2 h-px bg-hairline-faint" />
          <span className="px-1 pt-1 pb-1.5 text-white/40 text-xs uppercase tracking-[0.08em]">
            Use cases
          </span>
          {USE_CASE_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setMenuOpen(false)}
              className="rounded-[6px] px-1 py-2.5 text-base text-white/80 outline-none transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-accent"
            >
              {link.label}
            </Link>
          ))}
          <div className="my-2 h-px bg-hairline-faint" />
          <span className="px-1 pt-1 pb-1.5 text-white/40 text-xs uppercase tracking-[0.08em]">
            Recipes
          </span>
          {RECIPE_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setMenuOpen(false)}
              className="rounded-[6px] px-1 py-2.5 text-base text-white/80 outline-none transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-accent"
            >
              {link.label}
            </Link>
          ))}
          <Link
            href="/recipes"
            onClick={() => setMenuOpen(false)}
            className="rounded-[6px] px-1 py-2.5 text-base text-white/60 outline-none transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-accent"
          >
            Browse all 35 recipes →
          </Link>
          <div className="mt-3">
            <Button
              href="/docs/getting-started"
              variant="accent"
              className="w-full justify-center"
            >
              Start building
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}
