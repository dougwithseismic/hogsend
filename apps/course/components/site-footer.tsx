import Link from "next/link";
import type { JSX } from "react";
import { Logo } from "@/components/logo";
import { cn } from "@/lib/cn";
import { DISCORD_INVITE_URL, GITHUB_URL, HOGSEND_URL } from "@/lib/site";

type FooterLink = { label: string; href: string; external?: boolean };
type FooterColumn = { heading: string; links: FooterLink[] };

const COLUMNS: FooterColumn[] = [
  {
    heading: "Courses",
    links: [
      { label: "All courses", href: "/" },
      { label: "Measure, Keep, and Grow", href: "/growth-with-posthog" },
      { label: "Becoming a Product Team", href: "/becoming-a-product-team" },
      { label: "Pricing", href: "/pricing" },
    ],
  },
  {
    heading: "Account",
    links: [
      { label: "Your account", href: "/account" },
      { label: "Sign in", href: "/sign-in" },
    ],
  },
  {
    heading: "Hogsend",
    links: [
      { label: "hogsend.com", href: HOGSEND_URL, external: true },
      { label: "Docs", href: `${HOGSEND_URL}/docs`, external: true },
      { label: "GitHub", href: GITHUB_URL, external: true },
      { label: "Discord", href: DISCORD_INVITE_URL, external: true },
    ],
  },
  {
    heading: "Legal",
    links: [
      { label: "Cookies", href: "/cookies" },
      { label: "Privacy", href: `${HOGSEND_URL}/privacy`, external: true },
      { label: "Terms", href: `${HOGSEND_URL}/terms`, external: true },
    ],
  },
];

function FooterLinkItem({ link }: { link: FooterLink }): JSX.Element {
  const className =
    "text-base text-white/60 tracking-[-0.02em] transition-colors hover:text-white";
  if (link.external) {
    return (
      <a
        href={link.href}
        target="_blank"
        rel="noreferrer"
        className={className}
      >
        {link.label}
      </a>
    );
  }
  return (
    <Link href={link.href} className={className}>
      {link.label}
    </Link>
  );
}

/**
 * Slim crimzon footer for the course site: top hairline, brand block + a few
 * course-appropriate link columns, then a full-width hairline bottom bar.
 */
export function SiteFooter({ className }: { className?: string }): JSX.Element {
  return (
    <footer
      className={cn(
        "border-hairline-faint border-t bg-ink text-white",
        className,
      )}
    >
      <div className="container-page py-20">
        <div className="grid grid-cols-2 gap-x-8 gap-y-12 sm:grid-cols-3 lg:grid-cols-5">
          <div className="col-span-2 max-w-sm sm:col-span-1 sm:pr-6">
            <Logo />
            <p className="mt-5 text-base text-white/60 leading-6 tracking-[-0.02em]">
              Start-to-finish growth courses for the people who build it. Part
              of Hogsend — code-first lifecycle messaging for teams on PostHog.
            </p>
          </div>

          {COLUMNS.map((column) => (
            <nav key={column.heading} aria-label={column.heading}>
              <h2 className="font-medium text-base text-white tracking-[-0.02em]">
                {column.heading}
              </h2>
              <ul className="mt-5 flex flex-col gap-4">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <FooterLinkItem link={link} />
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
      </div>

      <div className="border-hairline-faint border-t">
        <div className="container-page flex flex-col items-start gap-3 py-6 text-sm text-white/50 sm:flex-row sm:items-center sm:justify-between">
          <p>© 2026 Hogsend</p>
          <a
            href={HOGSEND_URL}
            target="_blank"
            rel="noreferrer"
            className="transition-colors hover:text-white"
          >
            hogsend.com ↗
          </a>
        </div>
      </div>
    </footer>
  );
}
