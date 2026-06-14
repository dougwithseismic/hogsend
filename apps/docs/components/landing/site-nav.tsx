"use client";

import { ChevronDown, Menu, X } from "lucide-react";
import Link from "next/link";
import { type JSX, useEffect, useState } from "react";
import { Button } from "@/components/ds/button";
import { cn } from "@/lib/cn";
import { GITHUB_URL } from "@/lib/site";
import { Logo } from "./logo";

const NAV_LINKS: Array<{ label: string; href: string }> = [
  { label: "Templates", href: "/emails" },
  { label: "Pricing", href: "/pricing" },
  { label: "Docs", href: "/docs" },
  { label: "Changelog", href: "/changelog" },
];

type MenuItem = { label: string; description: string; href: string };
type MenuFooter = { label: string; href: string };

/** Items in the "Use cases" dropdown (and the mobile panel's second group). */
const USE_CASE_LINKS: MenuItem[] = [
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
    label: "Failed payments",
    description: "Reminders that sound human and stop when payment clears.",
    href: "/recipes/category/conversion#failed-payment-dunning",
  },
  {
    label: "Fire and forget",
    description: "Built for agents — domain to first send in half an hour.",
    href: "/fire-and-forget",
  },
];

/** Items in the "Recipes" dropdown — the eight catalog categories. */
const RECIPE_LINKS: MenuItem[] = [
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

/**
 * A center-nav item that opens a hover/focus mega panel. The trigger itself
 * still navigates (to the section or index), so it works without a pointer.
 */
function NavDropdown({
  label,
  triggerHref,
  items,
  footer,
}: {
  label: string;
  triggerHref: string;
  items: MenuItem[];
  footer: MenuFooter;
}): JSX.Element {
  return (
    <li className="group relative">
      <Link
        href={triggerHref}
        className="flex items-center gap-1 rounded text-[15px] tracking-[-0.02em] text-white/90 outline-none transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-accent"
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
            footer={{ label: "Browse all 33 recipes →", href: "/recipes" }}
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

        {/* Right: GitHub + CTA */}
        <div className="hidden items-center justify-end gap-4 md:flex">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="Hogsend on GitHub"
            className="flex size-9 items-center justify-center rounded-[6px] text-white/70 outline-none transition-colors hover:bg-white/5 hover:text-white focus-visible:ring-2 focus-visible:ring-accent"
          >
            <GitHubMark className="size-5" />
          </a>
          <Button href="/docs/getting-started" variant="outline" icon>
            Start building
          </Button>
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
            Browse all 33 recipes →
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
